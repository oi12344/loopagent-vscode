import { describe, expect, it } from "vitest";

import type { CodeEdge, CodeNode } from "../../src/extension/intelligence/graph/graphTypes";
import { buildExtractionSnapshot, type SnapshotInput } from "../../src/extension/intelligence/indexing/extractionSnapshot";

function snapshotInput(functionStartLine: number, body = "  consume(value);"): SnapshotInput {
  const lines = [
    ...Array.from({ length: functionStartLine - 1 }, () => ""),
    "export function createCodeCards(value: string): void {",
    body,
    "}",
    "function helper(): void {",
    "}",
  ];
  const file: CodeNode = {
    id: "file:sample",
    kind: "file",
    name: "sample.ts",
    qualifiedName: "src/sample.ts",
    filePath: "src/sample.ts",
    languageId: "typescript",
    startLine: 1,
    endLine: lines.length,
  };
  const run: CodeNode = {
    id: "run",
    kind: "function",
    name: "createCodeCards",
    qualifiedName: "src/sample.ts::createCodeCards",
    filePath: file.filePath,
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
    filePath: file.filePath,
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
    filePath: file.filePath,
    parsed: { filePath: file.filePath, languageId: "typescript", text: lines.join("\n"), diagnostics: [] },
    extraction: {
      nodes: [file, run, helper],
      edges: [contains(run.id), contains(helper.id)],
      importBindings: [],
      unresolvedReferences: [],
      diagnostics: [],
    },
  };
}

function singleSymbolInput({
  filePath,
  languageId,
  text,
  startLine,
  endLine,
}: {
  filePath: string;
  languageId: string;
  text: string;
  startLine: number;
  endLine: number;
}): SnapshotInput {
  const lineCount = text.split(/\r?\n/).length;
  const file: CodeNode = {
    id: "file",
    kind: "file",
    name: filePath.split("/").at(-1)!,
    qualifiedName: filePath,
    filePath,
    languageId,
    startLine: 1,
    endLine: lineCount,
  };
  const symbol: CodeNode = {
    id: "symbol",
    kind: languageId === "python" ? "class" : "function",
    name: "Service",
    qualifiedName: `${filePath}::Service`,
    filePath,
    languageId,
    startLine,
    endLine,
  };
  return {
    fileUri: `file:///workspace/${filePath}`,
    filePath,
    parsed: { filePath, languageId, text, diagnostics: [] },
    extraction: {
      nodes: [file, symbol],
      edges: [],
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
    const changed = buildExtractionSnapshot(snapshotInput(5, "  consume(value.trim());"));
    const symbol = (snapshot: typeof first) => snapshot.chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;

    expect(first.chunks.map((chunk) => chunk.chunkKind)).toEqual(["file_card", "symbol_card", "symbol_card"]);
    expect(first.chunks.find((chunk) => chunk.chunkKind === "file_card")?.sourceText).toContain("src/sample.ts");
    expect(symbol(first).sourceText).toBe([
      "export function createCodeCards(value: string): void {",
      "  consume(value);",
      "}",
    ].join("\n"));
    expect(first.chunks.find((chunk) => chunk.nodeId === first.nodes.find((node) => node.name === "createCodeCards")?.id)).toMatchObject({
      searchText: expect.stringContaining("create code cards"),
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      searchHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      embeddingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(moved.chunks.map((chunk) => chunk.id)).toEqual(first.chunks.map((chunk) => chunk.id));
    expect(moved.chunks.map((chunk) => chunk.searchHash)).toEqual(first.chunks.map((chunk) => chunk.searchHash));
    expect(symbol(moved).sourceHash).toBe(symbol(first).sourceHash);
    expect(symbol(changed).sourceHash).not.toBe(symbol(first).sourceHash);
    expect(symbol(changed).searchHash).toBe(symbol(first).searchHash);
    expect(symbol(changed).embeddingHash).toBe(symbol(first).embeddingHash);
  });

  it("clips symbol source and falls back for invalid ranges", () => {
    const longText = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join("\n");
    const longChunk = buildExtractionSnapshot(singleSymbolInput({
      filePath: "src/long.ts",
      languageId: "typescript",
      text: longText,
      startLine: 1,
      endLine: 130,
    })).chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;
    const pythonChunk = buildExtractionSnapshot(singleSymbolInput({
      filePath: "service.py",
      languageId: "python",
      text: "class Service:\n    pass",
      startLine: 1,
      endLine: 2,
    })).chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;
    const invalidChunk = buildExtractionSnapshot(singleSymbolInput({
      filePath: "src/invalid.ts",
      languageId: "typescript",
      text: "line 1\nline 2",
      startLine: 3,
      endLine: 4,
    })).chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;

    expect(longChunk.sourceText.split("\n")).toHaveLength(120);
    expect(pythonChunk.sourceText).toBe("class Service:\n    pass");
    expect(invalidChunk.sourceText).toContain("qualified:");
  });

  it.each([
    { name: "startLine below one", startLine: 0, endLine: 1, expectedSource: undefined },
    { name: "endLine before startLine", startLine: 2, endLine: 1, expectedSource: undefined },
    { name: "endLine past EOF", startLine: 2, endLine: 99, expectedSource: "line 2\nline 3" },
  ])("handles $name", ({ startLine, endLine, expectedSource }) => {
    const chunk = buildExtractionSnapshot(singleSymbolInput({
      filePath: "src/range.ts",
      languageId: "typescript",
      text: "line 1\nline 2\nline 3",
      startLine,
      endLine,
    })).chunks.find((candidate) => candidate.chunkKind === "symbol_card")!;

    if (expectedSource === undefined) expect(chunk.sourceText).toContain("qualified:");
    else expect(chunk.sourceText).toBe(expectedSource);
  });
});
