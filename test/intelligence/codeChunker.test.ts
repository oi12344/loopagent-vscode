import { describe, expect, it } from "vitest";

import type { CodeEdge, CodeNode } from "../../src/extension/intelligence/graph/graphTypes";
import { buildExtractionSnapshot, type SnapshotInput } from "../../src/extension/intelligence/indexing/extractionSnapshot";

function snapshotInput(functionStartLine: number): SnapshotInput {
  const file: CodeNode = {
    id: "file:sample",
    kind: "file",
    name: "sample.ts",
    qualifiedName: "src/sample.ts",
    filePath: "src/sample.ts",
    languageId: "typescript",
    startLine: 1,
    endLine: functionStartLine + 4,
  };
  const run: CodeNode = {
    id: "run",
    kind: "function",
    name: "createCodeCards",
    qualifiedName: "src/sample.ts::createCodeCards",
    filePath: "src/sample.ts",
    languageId: "typescript",
    startLine: functionStartLine,
    endLine: functionStartLine + 2,
    signature: "createCodeCards(value: string): void",
    isExported: true,
  };
  const helper: CodeNode = {
    id: "helper",
    kind: "function",
    name: "helper",
    qualifiedName: "src/sample.ts::helper",
    filePath: "src/sample.ts",
    languageId: "typescript",
    startLine: functionStartLine + 3,
    endLine: functionStartLine + 4,
    signature: "helper(): void",
  };
  const contains = (target: string): CodeEdge => ({
    id: `contains:${target}`,
    source: file.id,
    target,
    kind: "contains",
    filePath: file.filePath,
    line: 1,
    confidence: "exact",
  });

  return {
    fileUri: "file:///workspace/src/sample.ts",
    filePath: "src/sample.ts",
    parsed: {
      filePath: "src/sample.ts",
      languageId: "typescript",
      text: "export function createCodeCards(value: string): void {}\nfunction helper(): void {}",
      diagnostics: [],
    },
    extraction: {
      nodes: [file, run, helper],
      edges: [contains(run.id), contains(helper.id)],
      importBindings: [],
      unresolvedReferences: [],
      diagnostics: [],
    },
  };
}

describe("minimal code cards", () => {
  it("creates stable file and symbol cards without a duplicate file symbol", () => {
    const first = buildExtractionSnapshot(snapshotInput(5));
    const moved = buildExtractionSnapshot(snapshotInput(25));

    expect(first.chunks.map((chunk) => chunk.chunkKind)).toEqual(["file_card", "symbol_card", "symbol_card"]);
    expect(first.chunks.find((chunk) => chunk.chunkKind === "file_card")?.sourceText).toContain("src/sample.ts");
    expect(first.chunks.find((chunk) => chunk.nodeId === first.nodes.find((node) => node.name === "createCodeCards")?.id)).toMatchObject({
      searchText: expect.stringContaining("create code cards"),
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      searchHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      embeddingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(moved.chunks.map((chunk) => chunk.id)).toEqual(first.chunks.map((chunk) => chunk.id));
    expect(moved.chunks.map((chunk) => chunk.searchHash)).toEqual(first.chunks.map((chunk) => chunk.searchHash));
  });
});
