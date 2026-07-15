import { createHash } from "node:crypto";

import type { SnapshotDiagnostic, SnapshotFile, SnapshotImportBinding, SnapshotNode, SnapshotReference } from "../storage/indexTypes";
import { createStableChunkId } from "../indexing/stableIdentity";
import type { CodeChunk } from "./chunkTypes";
import { createSearchTokens } from "./searchText";

const MAX_SYMBOL_SOURCE_LINES = 120;

type CodeChunkInput = {
  file: SnapshotFile;
  fileText: string;
  nodes: readonly SnapshotNode[];
  importBindings: readonly SnapshotImportBinding[];
  unresolvedReferences: readonly SnapshotReference[];
  diagnostics: readonly SnapshotDiagnostic[];
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readSymbolSource(fileText: string, startLine: number, endLine: number): string | undefined {
  const lines = fileText.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length || endLine < startLine) return undefined;
  const startIndex = startLine - 1;
  return lines.slice(startIndex, Math.min(endLine, startIndex + MAX_SYMBOL_SOURCE_LINES, lines.length)).join("\n") || undefined;
}

function createChunk(input: Omit<CodeChunk, "id" | "sourceHash" | "searchHash" | "embeddingHash">): CodeChunk {
  return {
    ...input,
    id: createStableChunkId(input.fileId, input.chunkKind, input.semanticKey),
    sourceHash: hash(input.sourceText),
    searchHash: hash(input.searchText),
    embeddingHash: hash(input.embeddingText),
  };
}

export function createCodeChunks(input: CodeChunkInput): CodeChunk[] {
  const imports = input.importBindings.map((binding) => binding.importedName).join(", ");
  const declarations = input.nodes.filter((node) => node.kind !== "file").map((node) => node.name).join(", ");
  const fileSource = [
    `path: ${input.file.path}`,
    `language: ${input.file.languageId}`,
    `imports: ${imports}`,
    `symbols: ${declarations}`,
    `diagnostics: ${input.diagnostics.map((diagnostic) => diagnostic.message).join(" | ")}`,
  ].join("\n");
  const chunks: CodeChunk[] = [createChunk({
    fileId: input.file.id,
    semanticKey: "file_card",
    chunkKind: "file_card",
    sourceText: fileSource,
    searchText: createSearchTokens(`${input.file.path} ${declarations} ${imports}`).join(" "),
    embeddingText: fileSource,
  })];

  for (const node of input.nodes) {
    if (node.kind === "file") continue;
    const calls = input.unresolvedReferences.filter((reference) => reference.fromNodeId === node.id).map((reference) => reference.referenceName);
    const metadataText = [
      `name: ${node.name}`,
      `qualified: ${node.qualifiedName}`,
      `kind: ${node.kind}`,
      `signature: ${node.signature ?? ""}`,
      `exported: ${Boolean(node.isExported)}`,
      `calls: ${calls.join(", ")}`,
    ].join("\n");
    chunks.push(createChunk({
      fileId: input.file.id,
      nodeId: node.id,
      semanticKey: node.semanticKey,
      chunkKind: "symbol_card",
      sourceText: readSymbolSource(input.fileText, node.startLine, node.endLine) ?? metadataText,
      searchText: createSearchTokens(`${node.name} ${node.qualifiedName} ${node.signature ?? ""} ${calls.join(" ")}`).join(" "),
      embeddingText: metadataText,
      startLine: node.startLine,
      endLine: node.endLine,
    }));
  }
  return chunks;
}
