import type { CodeNode } from "./graphTypes";

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
      for (const segment of splitIdentifier(node.name)) {
        addToken(segment, node.id);
      }
      for (const part of node.filePath.split(/[\\/._-]+/)) {
        addToken(part, node.id);
        for (const segment of splitIdentifier(part)) {
          addToken(segment, node.id);
        }
      }
    },
    search(query, limit = 12) {
      const scores = new Map<string, number>();
      const queryTokens = splitQuery(query);

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

function splitQuery(query: string): string[] {
  return query
    .split(/[^A-Za-z0-9_$]+/)
    .flatMap(splitIdentifier)
    .map(normalizeToken)
    .filter((token) => token.length >= 2);
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9$]+/)
    .filter(Boolean);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
