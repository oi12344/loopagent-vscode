import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "../../src/extension/intelligence/languages/pythonAdapter";
import type { IndexDiagnostic } from "../../src/extension/intelligence/graph/graphTypes";

describe("Python adapter", () => {
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

  it("handles aliases, diagnostics, and indentation scope exits", () => {
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
    expect(result.diagnostics).toEqual([diagnostic]);
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
});
