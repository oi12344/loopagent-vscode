import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "../../src/extension/intelligence/languages/pythonAdapter";
import type { IndexDiagnostic } from "../../src/extension/intelligence/graph/graphTypes";
import { createTreeSitterParserRuntime } from "../../src/extension/intelligence/parser/treeSitterRuntime";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

async function extractWithTree(text: string) {
  const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
  const parsed = await runtime.parse("app/sample.py", "python", text);
  try {
    return createPythonAdapter().extract(parsed);
  } finally {
    parsed.tree?.delete();
  }
}

describe("Python adapter", () => {
  it("includes the AST start column in transient symbol IDs", async () => {
    const result = await extractWithTree("def run():\n    pass");
    const run = result.nodes.find((node) => node.name === "run");

    expect(run?.id).toBe("symbol:app/sample.py:function:run:1:0");
  });

  it("extracts imports, classes, functions, methods, and calls", () => {
    const adapter = createPythonAdapter();
    const result = adapter.extract({
      filePath: "app/service.py",
      languageId: "python",
      text: [
        "from app.repo import load_user",
        "def build_user():",
        "    return load_user()",
        "class UserService:",
        "    def run(self):",
        "        build_user()",
      ].join("\n"),
      tree: undefined,
      diagnostics: [],
    });

    expect(result.importBindings).toContainEqual({
      filePath: "app/service.py",
      localName: "load_user",
      importedName: "load_user",
      source: "app.repo",
      languageId: "python",
    });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "build_user" }),
        expect.objectContaining({ kind: "class", name: "UserService" }),
        expect.objectContaining({ kind: "method", name: "run" }),
      ]),
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: "calls", referenceName: "load_user" }),
        expect.objectContaining({ referenceKind: "calls", referenceName: "build_user" }),
      ]),
    );
  });

  it("handles aliases and indentation scope exits without owning parser diagnostics", () => {
    const adapter = createPythonAdapter();
    const diagnostic: IndexDiagnostic = {
      filePath: "app/service.py",
      severity: "warning",
      message: "fixture warning",
    };
    const result = adapter.extract({
      filePath: "app/service.py",
      languageId: "python",
      text: [
        "from app.repo import load_user as load",
        "def outer():",
        "    def inner():",
        "        return load()",
        "    return inner()",
        "class UserService:",
        "    def run(self):",
        "        def helper():",
        "            return load()",
        "        load()",
        "def outside():",
        "    load()",
      ].join("\n"),
      tree: undefined,
      diagnostics: [diagnostic],
    });

    const classNode = result.nodes.find((node) => node.kind === "class" && node.name === "UserService");
    const methodNode = result.nodes.find((node) => node.kind === "method" && node.name === "run");
    const outsideFunctionNode = result.nodes.find((node) => node.kind === "function" && node.name === "outside");

    expect(result.importBindings).toContainEqual({
      filePath: "app/service.py",
      localName: "load",
      importedName: "load_user",
      source: "app.repo",
      languageId: "python",
    });
    expect(result.diagnostics).toEqual([]);
    expect(methodNode).toEqual(expect.objectContaining({ kind: "method", name: "run" }));
    expect(result.nodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "method", name: "helper" })]),
    );
    expect(result.unresolvedReferences).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ referenceName: "load", line: 9 })]),
    );
    expect(outsideFunctionNode).toEqual(expect.objectContaining({ kind: "function", name: "outside" }));
    expect(result.edges).toContainEqual(expect.objectContaining({ source: classNode?.id, target: methodNode?.id }));
    expect(result.edges).toContainEqual(expect.objectContaining({ target: outsideFunctionNode?.id, source: "file:app/service.py" }));
    expect(result.unresolvedReferences).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ referenceName: "inner", line: 3 })]),
    );
  });

  it("extracts async decorated functions and method ranges from AST", async () => {
    const result = await extractWithTree(
      [
        "@trace",
        "async def run():",
        "    helper()",
        "class Service:",
        "    def start(self):",
        "        return run()",
      ].join("\n"),
    );

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "function",
          name: "run",
          startLine: 2,
          endLine: 3,
          metadata: expect.objectContaining({ decoratorStartLine: 1 }),
        }),
        expect.objectContaining({ kind: "class", name: "Service", startLine: 4, endLine: 6 }),
        expect.objectContaining({
          kind: "method",
          name: "start",
          qualifiedName: "app/sample.py::Service.start",
          startLine: 5,
          endLine: 6,
        }),
      ]),
    );
  });

  it("extracts Python imports and preserves member calls", async () => {
    const result = await extractWithTree(
      [
        "from .repo import load_user as load",
        "import app.client as client",
        "async def run():",
        "    load()",
        "    client.send()",
      ].join("\n"),
    );

    expect(result.importBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localName: "load", importedName: "load_user", source: ".repo" }),
        expect.objectContaining({ localName: "client", importedName: "app.client", source: "app.client" }),
      ]),
    );
    expect(result.importBindings).toHaveLength(2);
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceName: "load", calleeKind: "identifier", referenceKind: "calls" }),
        expect.objectContaining({
          referenceName: "send",
          receiverName: "client",
          calleeKind: "member",
          referenceKind: "calls",
        }),
      ]),
    );
  });

  it("keeps valid declarations when the syntax tree contains errors", async () => {
    const result = await extractWithTree("def valid():\n    pass\n\ndef broken(");

    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "function", name: "valid" }));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining("ERROR") }),
    ]);
  });
});
