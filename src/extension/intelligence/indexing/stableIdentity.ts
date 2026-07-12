import { createHash } from "node:crypto";
import path from "node:path";

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

export function normalizeWorkspaceRelativePath(workspaceRelativePath: string): string {
  return path.posix.normalize(workspaceRelativePath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

export function createFileId(workspaceRelativePath: string): string {
  const normalizedPath = normalizeWorkspaceRelativePath(workspaceRelativePath);
  return sha256(["file", normalizedPath]);
}

export function createSymbolSemanticKey(node: CodeNode, parentKey?: string): string {
  const normalizedFilePath = normalizeWorkspaceRelativePath(node.filePath);
  const normalizedQualifiedName = node.qualifiedName.startsWith(node.filePath)
    ? `${normalizedFilePath}${node.qualifiedName.slice(node.filePath.length)}`
    : node.qualifiedName;
  const declarationRole = node.metadata?.declarationOnly === true ? "declaration" : "concrete";
  return [parentKey ?? "", node.kind, normalizedQualifiedName, normalizeSignature(node.signature), declarationRole].join(
    "\u0000",
  );
}

export function createStableNodeId(fileId: string, semanticKey: string): string {
  return sha256(["node", fileId, semanticKey]);
}

export function createStableRelationId(kind: string, ...semanticParts: string[]): string {
  return sha256([kind, ...semanticParts]);
}
