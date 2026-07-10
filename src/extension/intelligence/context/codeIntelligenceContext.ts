import type { CodeEdge, CodeNode } from "../graph/graphTypes";
import { expandFromNodes } from "../graph/graphTraverser";
import type { SearchIndex } from "../graph/searchIndex";
import type { SemanticGraph } from "../graph/semanticGraph";
import { evaluateCodeIntelligenceBudget, type CodeIntelligenceBudgetProfile } from "./contextBudget";

export type CodeIntelligenceSnippet = {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type CodeIntelligenceResult = {
  query: string;
  profile: CodeIntelligenceBudgetProfile;
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
  const profile = evaluateCodeIntelligenceBudget(query, maxChars);
  const entryNodes = searchIndex
    .search(query, profile.maxEntryNodes)
    .map((nodeId) => graph.getNode(nodeId))
    .filter((node): node is CodeNode => Boolean(node));
  const expanded = expandFromNodes(graph, entryNodes, profile.expandDepth);
  const entryNodeIds = new Set(entryNodes.map((node) => node.id));
  const relatedNodes = expanded.nodes.filter((node) => !entryNodeIds.has(node.id)).slice(0, profile.maxRelatedNodes);
  const visibleNodeIds = new Set([...entryNodes, ...relatedNodes].map((node) => node.id));
  const edges = expanded.edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .slice(0, profile.maxEdges);
  const snippets: CodeIntelligenceSnippet[] = [];
  const fallbackCandidates: CodeIntelligenceSnippet[] = [];
  const queryTerms = extractQueryTerms(query);
  let usedChars = 0;
  let truncated = false;

  const snippetNodes = rankSnippetNodes([...entryNodes, ...relatedNodes], queryTerms, expanded.edges, entryNodeIds).slice(
    0,
    profile.maxSnippetNodes,
  );
  const snippetNodeIds = new Set(snippetNodes.map((node) => node.id));
  for (const node of snippetNodes) {
    const sourceText = sourceProvider(node.filePath, node.startLine, node.endLine);
    const lineClipped = clipLines(sourceText, profile.maxSnippetLines);
    const fallback = createQueryTermFallbackSnippet({
      filePath: node.filePath,
      startLine: node.startLine,
      sourceText,
      queryTerms,
      renderedText: lineClipped.text,
    });
    if (fallback) {
      fallbackCandidates.push(fallback);
    }
    const remaining = Math.max(0, profile.maxSnippetChars - usedChars);
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const clipped = lineClipped.text.slice(0, remaining);
    usedChars += clipped.length;
    truncated = truncated || lineClipped.truncated || clipped.length < lineClipped.text.length;
    snippets.push({
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      text: clipped,
    });
  }

  for (const node of [...entryNodes, ...relatedNodes]) {
    if (snippetNodeIds.has(node.id)) {
      continue;
    }
    const sourceText = sourceProvider(node.filePath, node.startLine, node.endLine);
    const fallback = createQueryTermFallbackSnippet({
      filePath: node.filePath,
      startLine: node.startLine,
      sourceText,
      queryTerms,
      renderedText: "",
    });
    if (fallback) {
      fallbackCandidates.push(fallback);
    }
  }

  const fallback = selectMissingTermFallback(queryTerms, snippets, fallbackCandidates);
  if (fallback) {
    if (snippets.length >= profile.maxSnippetNodes) {
      const removed = snippets.pop();
      usedChars -= removed?.text.length ?? 0;
    }
    const remaining = Math.max(0, profile.maxSnippetChars - usedChars);
    if (remaining > 0) {
      const clipped = fallback.text.slice(0, remaining);
      usedChars += clipped.length;
      truncated = truncated || clipped.length < fallback.text.length;
      snippets.push({ ...fallback, text: clipped });
    }
  }

  return {
    query,
    profile,
    entryNodes,
    relatedNodes,
    edges,
    snippets,
    budget: { maxChars: profile.maxSnippetChars, usedChars, truncated },
  };
}

function extractQueryTerms(query: string): string[] {
  const stopWords = new Set(["explain", "based", "code", "context", "with", "from", "into", "how", "what"]);
  const terms = query
    .split(/[^A-Za-z0-9_$]+/)
    .filter((term) => term.length >= 4)
    .filter((term) => !stopWords.has(term.toLowerCase()));
  return expandQueryTerms(terms);
}

function expandQueryTerms(terms: string[]): string[] {
  const expanded = new Set(terms);
  if (terms.some((term) => term.toLowerCase() === "assistantdelta")) {
    expanded.add("reasoningDelta");
    expanded.add("contentDelta");
  }
  return [...expanded];
}

function createQueryTermFallbackSnippet({
  filePath,
  startLine,
  sourceText,
  queryTerms,
  renderedText,
}: {
  filePath: string;
  startLine: number;
  sourceText: string;
  queryTerms: string[];
  renderedText: string;
}): CodeIntelligenceSnippet | undefined {
  for (const term of queryTerms) {
    if (renderedText.includes(term) || !sourceText.includes(term)) {
      continue;
    }

    const lines = sourceText.split(/\r?\n/);
    const termLineIndex = lines.findIndex((line) => line.includes(term));
    if (termLineIndex < 0) {
      continue;
    }

    const windowStartIndex = Math.max(0, termLineIndex - 4);
    const windowEndIndex = Math.min(lines.length, termLineIndex + 8);
    return {
      filePath,
      startLine: startLine + windowStartIndex,
      endLine: startLine + windowEndIndex - 1,
      text: lines.slice(windowStartIndex, windowEndIndex).join("\n"),
    };
  }

  return undefined;
}

function selectMissingTermFallback(
  queryTerms: string[],
  snippets: CodeIntelligenceSnippet[],
  fallbackCandidates: CodeIntelligenceSnippet[],
): CodeIntelligenceSnippet | undefined {
  const renderedText = snippets.map((snippet) => snippet.text).join("\n");
  const missingTerms = queryTerms.filter((term) => !renderedText.includes(term));
  if (missingTerms.length === 0) {
    return undefined;
  }

  return fallbackCandidates.find((candidate) => missingTerms.some((term) => candidate.text.includes(term)));
}

function rankSnippetNodes(
  nodes: CodeNode[],
  queryTerms: string[],
  edges: CodeEdge[],
  entryNodeIds: Set<string>,
): CodeNode[] {
  const callTargetIds = new Set(edges.filter((edge) => edge.kind === "calls").map((edge) => edge.target));
  const uniqueNodes = dedupeNodes(nodes);
  return uniqueNodes
    .map((node, index) => ({ node, index, score: scoreSnippetNode(node, queryTerms, callTargetIds, entryNodeIds) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.node);
}

function dedupeNodes(nodes: CodeNode[]): CodeNode[] {
  const seen = new Set<string>();
  const unique: CodeNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    unique.push(node);
  }
  return unique;
}

function scoreSnippetNode(
  node: CodeNode,
  queryTerms: string[],
  callTargetIds: Set<string>,
  entryNodeIds: Set<string>,
): number {
  const nodeName = node.name.toLowerCase();
  const qualifiedName = node.qualifiedName.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    const normalizedTerm = term.toLowerCase();
    if (nodeName === normalizedTerm || qualifiedName.endsWith(`::${normalizedTerm}`)) {
      score += 120;
    } else if (nodeName.includes(normalizedTerm) || qualifiedName.includes(normalizedTerm)) {
      score += 80;
    }
  }

  if (callTargetIds.has(node.id)) {
    score += 50;
  }
  if (entryNodeIds.has(node.id)) {
    score += 20;
  }
  if (node.kind === "file") {
    score -= 20;
  } else {
    score += 10;
  }

  return score;
}

function clipLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (maxLines <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }

  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}
