import { createHash } from "node:crypto";

import type { CodeNode } from "../graph/graphTypes";

function sha256(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest("hex");
}

function normalizeSignature(signature: string | undefined): string {
  return (signature ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([()[\]{},:;<>?=|&])\s*/g, "$1");
}

export function createFileId(fileUri: string): string {
  return sha256(["file", fileUri]);
}

export function createSymbolSemanticKey(node: CodeNode, parentKey?: string): string {
  return [parentKey ?? "", node.kind, node.qualifiedName, normalizeSignature(node.signature)].join("\u0000");
}

export function createStableNodeId(fileId: string, semanticKey: string): string {
  return sha256(["node", fileId, semanticKey]);
}

export function createStableRelationId(kind: string, ...semanticParts: string[]): string {
  return sha256([kind, ...semanticParts]);
}
