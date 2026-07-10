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

const openAiFileNode: CodeNode = {
  id: "file:src/extension/model/openAiCompatibleClient.ts",
  kind: "file",
  name: "openAiCompatibleClient.ts",
  qualifiedName: "src/extension/model/openAiCompatibleClient.ts",
  filePath: "src/extension/model/openAiCompatibleClient.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 130,
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

  it("uses graph summary context for architecture and call graph questions", () => {
    const { graph, searchIndex } = createIndexedGraph();

    const result = createCodeIntelligenceContext({
      query: "show call graph dependencies and impact for configured agent",
      graph,
      searchIndex,
      sourceProvider: () => "source should not be loaded for graph summary",
      maxChars: 8_000,
    });

    expect(result.profile.mode).toBe("graph-summary");
    expect(result.snippets).toEqual([]);
    expect(result.edges).toContainEqual(callEdge);
    expect(result.budget.maxChars).toBeLessThan(8_000);
  });

  it("uses focused source context for implementation explanation questions", () => {
    const { graph, searchIndex } = createIndexedGraph();

    const result = createCodeIntelligenceContext({
      query: "explain how createConfiguredAgentRunner builds the system prompt",
      graph,
      searchIndex,
      sourceProvider: () => "0123456789".repeat(1_000),
      maxChars: 8_000,
    });

    expect(result.profile.mode).toBe("focused-source");
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.snippets.length).toBeLessThanOrEqual(result.profile.maxSnippetNodes);
    expect(result.profile.maxSnippetNodes).toBeLessThan(6);
    expect(result.budget.maxChars).toBeLessThan(8_000);
    expect(result.budget.usedChars).toBeLessThanOrEqual(result.budget.maxChars);
  });

  it("uses expanded source context for code change and debugging questions", () => {
    const { graph, searchIndex } = createIndexedGraph();

    const result = createCodeIntelligenceContext({
      query: "fix a bug in createConfiguredAgentRunner and update its implementation",
      graph,
      searchIndex,
      sourceProvider: () => "0123456789".repeat(1_000),
      maxChars: 8_000,
    });

    expect(result.profile.mode).toBe("expanded-source");
    expect(result.profile.maxSnippetNodes).toBeGreaterThan(3);
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.budget.usedChars).toBeLessThanOrEqual(result.budget.maxChars);
  });

  it("adds a focused query-term snippet when a long matched file clips the requested symbol", () => {
    const graph = createSemanticGraph();
    const searchIndex = createSearchIndex();
    graph.upsertNode(openAiFileNode);
    searchIndex.addNode(openAiFileNode);
    const sourceText = [
      ...Array.from({ length: 110 }, (_, index) => `const line${index + 1} = true;`),
      'yield { type: "reasoningDelta" as const, content: reasoningContent };',
      'yield { type: "contentDelta" as const, content };',
    ].join("\n");

    const result = createCodeIntelligenceContext({
      query: "explain openAiCompatibleClient.ts assistantDelta",
      graph,
      searchIndex,
      sourceProvider: () => sourceText,
      maxChars: 8_000,
    });

    const snippets = result.snippets.map((snippet) => snippet.text).join("\n");
    expect(snippets).toContain("reasoningDelta");
    expect(snippets).toContain("contentDelta");
  });

  it("prioritizes second-hop call target snippets for focused source questions", () => {
    const graph = createSemanticGraph();
    const searchIndex = createSearchIndex();
    const createClientNode = {
      ...providerNode,
      id: "symbol:src/openAiCompatibleClient.ts:function:createOpenAiCompatibleClient:1",
      name: "createOpenAiCompatibleClient",
      qualifiedName: "src/openAiCompatibleClient.ts::createOpenAiCompatibleClient",
      filePath: "src/openAiCompatibleClient.ts",
    };
    const streamNode = {
      ...providerNode,
      id: "symbol:src/openAiCompatibleClient.ts:function:streamChatCompletion:5",
      name: "streamChatCompletion",
      qualifiedName: "src/openAiCompatibleClient.ts::streamChatCompletion",
      filePath: "src/openAiCompatibleClient.ts",
      startLine: 5,
      endLine: 8,
    };
    const mapNode = {
      ...providerNode,
      id: "symbol:src/openAiCompatibleClient.ts:function:mapChunkEvents:20",
      name: "mapChunkEvents",
      qualifiedName: "src/openAiCompatibleClient.ts::mapChunkEvents",
      filePath: "src/openAiCompatibleClient.ts",
      startLine: 20,
      endLine: 24,
    };
    const noisyNodes = Array.from({ length: 5 }, (_, index): CodeNode => ({
      ...providerNode,
      id: `symbol:src/openAiCompatibleClient.ts:function:createNoisy${index}:30`,
      name: `createNoisy${index}`,
      qualifiedName: `src/openAiCompatibleClient.ts::createNoisy${index}`,
      filePath: "src/openAiCompatibleClient.ts",
      startLine: 30 + index,
      endLine: 30 + index,
    }));
    for (const node of [createClientNode, ...noisyNodes, streamNode, mapNode]) {
      graph.upsertNode(node);
      searchIndex.addNode(node);
    }
    graph.upsertEdge({
      id: "edge:create:calls:stream:2",
      source: createClientNode.id,
      target: streamNode.id,
      kind: "calls",
      filePath: "src/openAiCompatibleClient.ts",
      line: 2,
      confidence: "exact",
    });
    graph.upsertEdge({
      id: "edge:stream:calls:map:7",
      source: streamNode.id,
      target: mapNode.id,
      kind: "calls",
      filePath: "src/openAiCompatibleClient.ts",
      line: 7,
      confidence: "exact",
    });

    const result = createCodeIntelligenceContext({
      query: "explain createOpenAiCompatibleClient SSE assistantDelta",
      graph,
      searchIndex,
      sourceProvider: (_filePath, startLine) =>
        startLine === 20
          ? [
              "function* mapChunkEvents() {",
              '  yield { type: "reasoningDelta" as const, content: reasoningContent };',
              '  yield { type: "contentDelta" as const, content };',
              "}",
            ].join("\n")
          : "irrelevant snippet",
      maxChars: 8_000,
    });

    const snippets = result.snippets.map((snippet) => snippet.text).join("\n");
    expect(snippets).toContain("mapChunkEvents");
    expect(snippets).toContain("reasoningDelta");
    expect(snippets).toContain("contentDelta");
  });
});
