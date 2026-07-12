import { describe, expect, it, vi } from "vitest";

import type { CodeNode } from "../../src/extension/intelligence/graph/graphTypes";
import { buildExtractionSnapshot } from "../../src/extension/intelligence/indexing/extractionSnapshot";
import {
  createFileId,
  createStableNodeId,
  createSymbolSemanticKey,
} from "../../src/extension/intelligence/indexing/stableIdentity";

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

  it("hashes UTF-8 semantic inputs without volatile location data", () => {
    const fileId = createFileId("file:///workspace/src/\u793a\u4f8b.ts");
    const semanticKey = createSymbolSemanticKey(functionNode("run", "run(): void"));

    expect(fileId).toMatch(/^[a-f0-9]{64}$/);
    expect(createStableNodeId(fileId, semanticKey)).toMatch(/^[a-f0-9]{64}$/);
    expect(createSymbolSemanticKey(functionNode("run", "run(): void", 100))).toBe(semanticKey);
  });
});
