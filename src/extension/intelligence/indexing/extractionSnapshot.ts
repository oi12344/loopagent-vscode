import { createHash } from "node:crypto";

import type { ExtractionResult } from "../languages/languageAdapter";
import type { ParsedSource } from "../parser/parserRuntime";
import type {
  ExtractionSnapshot,
  SnapshotDiagnostic,
  SnapshotEdge,
  SnapshotImportBinding,
  SnapshotNode,
  SnapshotReference,
} from "../storage/indexTypes";
import {
  createFileId,
  createStableNodeId,
  createStableRelationId,
  createSymbolSemanticKey,
} from "./stableIdentity";

export type SnapshotInput = {
  fileUri: string;
  filePath: string;
  parsed: ParsedSource;
  extraction: ExtractionResult;
};

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildExtractionSnapshot(input: SnapshotInput): ExtractionSnapshot {
  const fileId = createFileId(input.fileUri);
  const parentByNodeId = new Map(
    input.extraction.edges.filter((edge) => edge.kind === "contains").map((edge) => [edge.target, edge.source]),
  );
  const nodeByOldId = new Map(input.extraction.nodes.map((node) => [node.id, node]));
  const semanticKeyByOldId = new Map<string, string>();

  function semanticKeyFor(oldId: string, ancestors = new Set<string>()): string {
    const cached = semanticKeyByOldId.get(oldId);
    if (cached) return cached;
    const node = nodeByOldId.get(oldId);
    if (!node) throw new Error(`Cannot create stable identity for missing node: ${oldId}`);
    if (ancestors.has(oldId)) throw new Error(`Contains relationship cycle detected at node: ${oldId}`);
    const parentId = parentByNodeId.get(oldId);
    const parentKey = parentId ? semanticKeyFor(parentId, new Set([...ancestors, oldId])) : undefined;
    const semanticKey = createSymbolSemanticKey(node, parentKey);
    semanticKeyByOldId.set(oldId, semanticKey);
    return semanticKey;
  }

  const stableIdByOldId = new Map<string, string>();
  const nodes: SnapshotNode[] = input.extraction.nodes.map((node) => {
    const semanticKey = semanticKeyFor(node.id);
    const id = createStableNodeId(fileId, semanticKey);
    stableIdByOldId.set(node.id, id);
    return { ...node, id, fileId, semanticKey };
  });

  function stableNodeId(oldId: string): string {
    const stableId = stableIdByOldId.get(oldId);
    if (!stableId) throw new Error(`Cannot rewrite reference to missing node: ${oldId}`);
    return stableId;
  }

  const edges: SnapshotEdge[] = input.extraction.edges.map((edge) => {
    const sourceNodeId = stableNodeId(edge.source);
    const targetNodeId = stableNodeId(edge.target);
    return {
      ...edge,
      id: createStableRelationId("edge", fileId, edge.kind, sourceNodeId, targetNodeId),
      source: sourceNodeId,
      target: targetNodeId,
      sourceNodeId,
      targetNodeId,
      fileId,
    };
  });

  const importBindings: SnapshotImportBinding[] = input.extraction.importBindings.map((binding) => ({
    ...binding,
    id: createStableRelationId(
      "binding",
      fileId,
      binding.localName,
      binding.importedName,
      binding.source,
    ),
    fileId,
    resolvedFileId: binding.resolvedFilePath ? createFileId(binding.resolvedFilePath) : undefined,
  }));
  const unresolvedReferences: SnapshotReference[] = input.extraction.unresolvedReferences.map((reference) => {
    const fromNodeId = stableNodeId(reference.fromNodeId);
    return {
      ...reference,
      id: createStableRelationId(
        "reference",
        fileId,
        fromNodeId,
        reference.referenceKind,
        reference.referenceName,
      ),
      fileId,
      fromNodeId,
    };
  });
  const diagnostics: SnapshotDiagnostic[] = input.extraction.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    id: createStableRelationId("diagnostic", fileId, diagnostic.severity, diagnostic.message),
    fileId,
  }));

  return {
    file: {
      id: fileId,
      uri: input.fileUri,
      path: input.filePath,
      languageId: input.parsed.languageId,
      contentHash: contentHash(input.parsed.text),
      byteLength: Buffer.byteLength(input.parsed.text, "utf8"),
    },
    nodes,
    edges,
    importBindings,
    unresolvedReferences,
    diagnostics,
  };
}
