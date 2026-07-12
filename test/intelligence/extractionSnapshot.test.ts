import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import type { CodeNode } from "../../src/extension/intelligence/graph/graphTypes";
import { createTypeScriptAdapter } from "../../src/extension/intelligence/languages/typescriptAdapter";
import { buildExtractionSnapshot } from "../../src/extension/intelligence/indexing/extractionSnapshot";
import {
  createFileId,
  createStableNodeId,
  createSymbolSemanticKey,
} from "../../src/extension/intelligence/indexing/stableIdentity";
import { createTreeSitterParserRuntime } from "../../src/extension/intelligence/parser/treeSitterRuntime";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

function functionNode(name: string, signature: string, startLine = 5): CodeNode {
  return {
    id: `temporary:${name}:${startLine}`,
    kind: "function",
    name,
    qualifiedName: `src/sample.ts::${name}`,
    filePath: "src/sample.ts",
    languageId: "typescript",
    startLine,
    endLine: startLine + 2,
    signature,
  };
}

function snapshotInput(functionStartLine: number, callLine: number) {
  const fileNode: CodeNode = {
    id: "temporary:file",
    kind: "file",
    name: "sample.ts",
    qualifiedName: "src/sample.ts",
    filePath: "src/sample.ts",
    languageId: "typescript",
    startLine: 1,
    endLine: functionStartLine + 2,
  };
  const caller = functionNode("run", "run(value: string): void", functionStartLine);
  const target = functionNode("helper", "helper(): void", functionStartLine + 4);
  const deleteTree = vi.fn();

  return {
    input: {
      fileUri: "file:///workspace/src/sample.ts",
      filePath: "src/sample.ts",
      parsed: {
        filePath: "src/sample.ts",
        languageId: "typescript",
        text: "export function run(value: string): void { helper(); }",
        tree: { rootNode: {} as never, delete: deleteTree },
        diagnostics: [],
      },
      extraction: {
        nodes: [fileNode, caller, target],
        edges: [
          {
            id: `temporary:edge:${callLine}`,
            source: caller.id,
            target: target.id,
            kind: "calls" as const,
            filePath: "src/sample.ts",
            line: callLine,
            confidence: "exact" as const,
          },
        ],
        importBindings: [
          {
            filePath: "src/sample.ts",
            localName: "helper",
            importedName: "helper",
            source: "./helper",
            resolvedFilePath: "src/helper.ts",
            languageId: "typescript",
          },
        ],
        unresolvedReferences: [
          {
            fromNodeId: caller.id,
            referenceName: "missing",
            referenceKind: "calls" as const,
            filePath: "src/sample.ts",
            line: callLine,
            languageId: "typescript",
          },
        ],
        diagnostics: [{ filePath: "src/sample.ts", severity: "warning" as const, message: "fixture" }],
      },
    },
    deleteTree,
  };
}

describe("stable extraction snapshots", () => {
  it("keeps node and edge identities stable when ranges move", () => {
    const firstFixture = snapshotInput(5, 6);
    const movedFixture = snapshotInput(25, 26);
    const first = buildExtractionSnapshot(firstFixture.input);
    const moved = buildExtractionSnapshot(movedFixture.input);
    const firstRun = first.nodes.find((node) => node.name === "run");
    const movedRun = moved.nodes.find((node) => node.name === "run");

    expect(movedRun?.id).toBe(firstRun?.id);
    expect(movedRun?.semanticKey).toBe(firstRun?.semanticKey);
    expect(moved.edges[0]?.id).toBe(first.edges[0]?.id);
    expect(moved.edges[0]?.sourceNodeId).toBe(first.edges[0]?.sourceNodeId);
    expect(movedRun?.startLine).toBe(25);
    expect(moved.unresolvedReferences[0]?.fromNodeId).toBe(movedRun?.id);
    expect(firstFixture.deleteTree).not.toHaveBeenCalled();
    expect(movedFixture.deleteTree).not.toHaveBeenCalled();
  });

  it("distinguishes overloads by normalized signature", () => {
    const stringKey = createSymbolSemanticKey(functionNode("run", "run( value:   string ): void"));
    const equivalentKey = createSymbolSemanticKey(functionNode("run", "run(value: string): void"));
    const numberKey = createSymbolSemanticKey(functionNode("run", "run(value: number): void"));

    expect(stringKey).toBe(equivalentKey);
    expect(stringKey).not.toBe(numberKey);
  });

  it("distinguishes overload identities extracted from a real TypeScript syntax tree", async () => {
    const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
    const parsed = await runtime.parse(
      "src/sample.ts",
      "typescript",
      [
        "export function run(value: string): void;",
        "export function run(value: number): void;",
        "export function run(value: string | number): void {}",
      ].join("\n"),
    );
    try {
      const extraction = createTypeScriptAdapter().extract(parsed);
      const snapshot = buildExtractionSnapshot({
        fileUri: "file:///workspace/src/sample.ts",
        filePath: "src/sample.ts",
        parsed,
        extraction,
      });
      const overloads = snapshot.nodes.filter((node) => node.kind === "function" && node.name === "run");

      expect(overloads.map((node) => node.signature)).toEqual([
        "run(value: string): void",
        "run(value: number): void",
        "run(value: string | number): void",
      ]);
      expect(new Set(overloads.map((node) => node.id)).size).toBe(3);
    } finally {
      parsed.tree?.delete();
    }
  });

  it("hashes UTF-8 semantic inputs without volatile location data", () => {
    const fileId = createFileId("src/\u793a\u4f8b.ts");
    const semanticKey = createSymbolSemanticKey(functionNode("run", "run(): void"));

    expect(fileId).toMatch(/^[a-f0-9]{64}$/);
    expect(createStableNodeId(fileId, semanticKey)).toMatch(/^[a-f0-9]{64}$/);
    expect(createSymbolSemanticKey(functionNode("run", "run(): void", 100))).toBe(semanticKey);
  });

  it("uses normalized workspace-relative paths for files and resolved bindings", () => {
    const fixture = snapshotInput(5, 6);
    const snapshot = buildExtractionSnapshot(fixture.input);

    expect(createFileId(".\\src\\nested\\..\\sample.ts")).toBe(createFileId("src/sample.ts"));
    expect(createFileId("./src//sample.ts")).toBe(createFileId("src/sample.ts"));
    expect(snapshot.file.id).toBe(createFileId("src/sample.ts"));
    expect(snapshot.file.uri).toBe("file:///workspace/src/sample.ts");
    expect(snapshot.importBindings[0]?.resolvedFileId).toBe(createFileId("src/helper.ts"));
  });

  it("disambiguates duplicate relations while preserving ordinal identity across range moves", () => {
    const firstFixture = snapshotInput(5, 6);
    const movedFixture = snapshotInput(25, 26);
    for (const fixture of [firstFixture, movedFixture]) {
      const { extraction } = fixture.input;
      extraction.edges.push({ ...extraction.edges[0]!, id: "duplicate-edge", line: extraction.edges[0]!.line! + 1 });
      extraction.unresolvedReferences.push({
        ...extraction.unresolvedReferences[0]!,
        line: extraction.unresolvedReferences[0]!.line + 1,
      });
      extraction.importBindings.push({ ...extraction.importBindings[0]! });
      extraction.diagnostics.push({ ...extraction.diagnostics[0]! });
    }

    const first = buildExtractionSnapshot(firstFixture.input);
    const moved = buildExtractionSnapshot(movedFixture.input);
    for (const key of ["edges", "unresolvedReferences", "importBindings", "diagnostics"] as const) {
      const firstIds = first[key].map((item) => item.id);
      const movedIds = moved[key].map((item) => item.id);
      expect(new Set(firstIds).size).toBe(firstIds.length);
      expect(movedIds).toEqual(firstIds);
    }
  });

  it("normalizes qualified-name path prefixes when creating snapshot node identities", () => {
    const windowsFixture = snapshotInput(5, 6);
    windowsFixture.input.filePath = ".\\src\\nested\\..\\sample.ts";
    windowsFixture.input.parsed.filePath = windowsFixture.input.filePath;
    for (const node of windowsFixture.input.extraction.nodes) {
      node.filePath = windowsFixture.input.filePath;
      node.qualifiedName = node.qualifiedName.replace("src/sample.ts", windowsFixture.input.filePath);
    }
    const posix = buildExtractionSnapshot(snapshotInput(5, 6).input);
    const windows = buildExtractionSnapshot(windowsFixture.input);

    expect(windows.file.id).toBe(posix.file.id);
    expect(windows.nodes.map((node) => node.id)).toEqual(posix.nodes.map((node) => node.id));
  });

  it("disambiguates same-signature declarations, implementations, and merged interfaces", async () => {
    async function extractSnapshot(prefix = "") {
      const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
      const parsed = await runtime.parse(
        "src/overloads.ts",
        "typescript",
        [
          prefix,
          "function execute(value: string): void;",
          "function execute(value: string): void {}",
          "class Service {",
          "  constructor(value: string);",
          "  constructor(value: string) {}",
          "  run(value: string): void;",
          "  run(value: string): void {}",
          "}",
          "interface Contract { run(value: string): void; }",
          "interface Contract { run(value: string): void; }",
        ].join("\n"),
      );
      try {
        return buildExtractionSnapshot({
          fileUri: "file:///workspace/src/overloads.ts",
          filePath: "src/overloads.ts",
          parsed,
          extraction: createTypeScriptAdapter().extract(parsed),
        });
      } finally {
        parsed.tree?.delete();
      }
    }

    const first = await extractSnapshot();
    const moved = await extractSnapshot("\n\n");
    const relevant = (snapshot: ReturnType<typeof buildExtractionSnapshot>) =>
      snapshot.nodes.filter((node) => ["execute", "constructor", "run", "Contract"].includes(node.name));
    const firstNodes = relevant(first);
    const movedNodes = relevant(moved);
    const ids = firstNodes.map((node) => node.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(movedNodes.map((node) => node.id)).toEqual(ids);
    expect(firstNodes.filter((node) => node.name === "execute").map((node) => node.metadata?.declarationOnly)).toEqual([
      true,
      undefined,
    ]);
    const contracts = firstNodes.filter((node) => node.name === "Contract");
    expect(contracts).toHaveLength(2);
    expect(new Set(contracts.map((node) => node.semanticKey)).size).toBe(2);
  });
});
