import type { CodeNode } from "./graphTypes";
import { createSearchTokens } from "../chunking/searchText";

// Simple in-memory inverted index for fallback search. This is part of the in-memory WorkspaceIntelligence
// fallback path and is independent from the SQLite FTS5 index (search_index_fts table in sqliteIndexStore.ts).
// Changes to this do not affect the persistent index and vice versa.
export type SearchIndex = {
  addNode(node: CodeNode): void;
  search(query: string, limit?: number): string[];
};

export function createSearchIndex(): SearchIndex {
  const nodeIdsByToken = new Map<string, Set<string>>();
  const tokensByNodeId = new Map<string, Set<string>>();
  const knownNodeIds: string[] = [];

  function addToken(token: string, nodeId: string): void {
    const normalized = normalizeToken(token);
    if (!normalized) {
      return;
    }

    const bucket = nodeIdsByToken.get(normalized) ?? new Set<string>();
    bucket.add(nodeId);
    nodeIdsByToken.set(normalized, bucket);

    const nodeTokens = tokensByNodeId.get(nodeId) ?? new Set<string>();
    nodeTokens.add(normalized);
    tokensByNodeId.set(nodeId, nodeTokens);
  }

  function removeNodeTokens(nodeId: string): void {
    const nodeTokens = tokensByNodeId.get(nodeId);
    if (!nodeTokens) {
      return;
    }

    for (const token of nodeTokens) {
      const bucket = nodeIdsByToken.get(token);
      if (!bucket) {
        continue;
      }

      bucket.delete(nodeId);
      if (bucket.size === 0) {
        nodeIdsByToken.delete(token);
      }
    }
    tokensByNodeId.delete(nodeId);
  }

  return {
    addNode(node) {
      if (!knownNodeIds.includes(node.id)) {
        knownNodeIds.push(node.id);
      }
      removeNodeTokens(node.id);

      addToken(node.name, node.id);
      for (const segment of createSearchTokens(node.name)) {
        addToken(segment, node.id);
      }
      for (const segment of createSearchTokens(node.qualifiedName)) {
        addToken(segment, node.id);
      }
      for (const part of node.filePath.split(/[\\/._-]+/)) {
        addToken(part, node.id);
        for (const segment of createSearchTokens(part)) {
          addToken(segment, node.id);
        }
      }
    },
    search(query, limit = 12) {
      const scores = new Map<string, number>();
      const queryTokens = createSearchTokens(query);

      for (const token of queryTokens) {
        const matches = nodeIdsByToken.get(token);
        if (!matches) {
          continue;
        }

        for (const nodeId of matches) {
          scores.set(nodeId, (scores.get(nodeId) ?? 0) + 1);
        }
      }

      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || knownNodeIds.indexOf(a[0]) - knownNodeIds.indexOf(b[0]))
        .slice(0, limit)
        .map(([nodeId]) => nodeId);
    },
  };
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
