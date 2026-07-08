import { describe, expect, it } from "vitest";

import { createCodeIntelligenceContext } from "../../src/extension/intelligence/context/codeIntelligenceContext";
import type { CodeEdge, CodeNode } from "../../src/extension/intelligence/graph/graphTypes";
import { createSearchIndex } from "../../src/extension/intelligence/graph/searchIndex";
import { createSemanticGraph } from "../../src/extension/intelligence/graph/semanticGraph";

const providerNode: CodeNode = {
  id: "symbol:src/providerRegistry.ts:function:createConfiguredAgentRunner:1",
  kind: "function",
  name: "createConfiguredAgentRunner",
  qualifiedName: "src/providerRegistry.ts::createConfiguredAgentRunner",
  filePath: "src/providerRegistry.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 4,
};

const modelRunnerNode: CodeNode = {
  id: "symbol:src/modelRunner.ts:function:createModelRunner:1",
  kind: "function",
  name: "createModelRunner",
  qualifiedName: "src/modelRunner.ts::createModelRunner",
  filePath: "src/modelRunner.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 4,
};

const callEdge: CodeEdge = {
  id: "edge:provider:calls:runner:2",
  source: providerNode.id,
  target: modelRunnerNode.id,
  kind: "calls",
  filePath: "src/providerRegistry.ts",
  line: 2,
  confidence: "exact",
};

function createIndexedGraph() {
  const graph = createSemanticGraph();
  const searchIndex = createSearchIndex();
  for (const node of [providerNode, modelRunnerNode]) {
    graph.upsertNode(node);
    searchIndex.addNode(node);
  }
  graph.upsertEdge(callEdge);
  return { graph, searchIndex };
}

describe("createCodeIntelligenceContext", () => {
  it("finds entry nodes and expands related call edges", () => {
    const { graph, searchIndex } = createIndexedGraph();

    const result = createCodeIntelligenceContext({
      query: "configured agent",
      graph,
      searchIndex,
      sourceProvider: (filePath, startLine, endLine) => `${filePath}:${startLine}-${endLine}`,
    });

    expect(result.entryNodes).toEqual([providerNode]);
    expect(result.relatedNodes).toContainEqual(modelRunnerNode);
    expect(result.edges).toContainEqual(callEdge);
    expect(result.snippets).toContainEqual(
      expect.objectContaining({
        filePath: "src/providerRegistry.ts",
        text: "src/providerRegistry.ts:1-4",
      }),
    );
  });

  it("clips snippets to the configured character budget", () => {
    const { graph, searchIndex } = createIndexedGraph();

    const result = createCodeIntelligenceContext({
      query: "configured agent",
      graph,
      searchIndex,
      sourceProvider: () => "0123456789",
      maxChars: 6,
    });

    expect(result.snippets[0]?.text).toBe("012345");
    expect(result.budget).toEqual({ maxChars: 6, usedChars: 6, truncated: true });
  });
});
