import type { CodeEdge, CodeNode } from "../graph/graphTypes";
import { expandFromNodes } from "../graph/graphTraverser";
import type { SearchIndex } from "../graph/searchIndex";
import type { SemanticGraph } from "../graph/semanticGraph";

export type CodeIntelligenceSnippet = {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type CodeIntelligenceResult = {
  query: string;
  entryNodes: CodeNode[];
  relatedNodes: CodeNode[];
  edges: CodeEdge[];
  snippets: CodeIntelligenceSnippet[];
  budget: {
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
};

export type CreateCodeIntelligenceContextOptions = {
  query: string;
  graph: SemanticGraph;
  searchIndex: SearchIndex;
  sourceProvider: (filePath: string, startLine: number, endLine: number) => string;
  maxChars?: number;
};

export function createCodeIntelligenceContext({
  query,
  graph,
  searchIndex,
  sourceProvider,
  maxChars = 8_000,
}: CreateCodeIntelligenceContextOptions): CodeIntelligenceResult {
  const entryNodes = searchIndex
    .search(query, 6)
    .map((nodeId) => graph.getNode(nodeId))
    .filter((node): node is CodeNode => Boolean(node));
  const expanded = expandFromNodes(graph, entryNodes, 1);
  const entryNodeIds = new Set(entryNodes.map((node) => node.id));
  const relatedNodes = expanded.nodes.filter((node) => !entryNodeIds.has(node.id));
  const snippets: CodeIntelligenceSnippet[] = [];
  let usedChars = 0;
  let truncated = false;

  for (const node of expanded.nodes) {
    const text = sourceProvider(node.filePath, node.startLine, node.endLine);
    const remaining = Math.max(0, maxChars - usedChars);
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const clipped = text.slice(0, remaining);
    usedChars += clipped.length;
    truncated = truncated || clipped.length < text.length;
    snippets.push({
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      text: clipped,
    });
  }

  return {
    query,
    entryNodes,
    relatedNodes,
    edges: expanded.edges,
    snippets,
    budget: { maxChars, usedChars, truncated },
  };
}
