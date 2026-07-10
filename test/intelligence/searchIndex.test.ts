import { describe, expect, it } from "vitest";

import { createSearchIndex } from "../../src/extension/intelligence/graph/searchIndex";
import type { CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const node: CodeNode = {
  id: "symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:12",
  kind: "function",
  name: "createConfiguredAgentRunner",
  qualifiedName: "src/extension/model/providerRegistry.ts::createConfiguredAgentRunner",
  filePath: "src/extension/model/providerRegistry.ts",
  languageId: "typescript",
  startLine: 12,
  endLine: 30,
};

describe("SearchIndex", () => {
  it("finds symbols by exact name, file path, and name segments", () => {
    const index = createSearchIndex();
    index.addNode(node);

    expect(index.search("createConfiguredAgentRunner")).toEqual([node.id]);
    expect(index.search("configured runner")).toEqual([node.id]);
    expect(index.search("providerRegistry")).toEqual([node.id]);
  });

  it("splits snake_case names and kebab-case paths into searchable segments", () => {
    const index = createSearchIndex();
    const kebabPathNodeId = "symbol:src/example.ts:function:readSettings:2";

    index.addNode({
      ...node,
      id: "symbol:src/example.ts:function:create_configured_runner:1",
      name: "create_configured_runner",
      qualifiedName: "src/example.ts::create_configured_runner",
      filePath: "src/example.ts",
    });
    index.addNode({
      ...node,
      id: kebabPathNodeId,
      name: "readSettings",
      qualifiedName: "src/create-configured-runner.ts::readSettings",
      filePath: "src/create-configured-runner.ts",
    });

    expect(index.search("configured runner")).toEqual([
      "symbol:src/example.ts:function:create_configured_runner:1",
      kebabPathNodeId,
    ]);
  });

  it("replaces stale tokens when the same node id is added again", () => {
    const index = createSearchIndex();
    index.addNode(node);
    index.addNode({
      ...node,
      name: "runModel",
      qualifiedName: "src/extension/model/modelRunner.ts::runModel",
      filePath: "src/extension/model/modelRunner.ts",
    });

    expect(index.search("configured")).toEqual([]);
    expect(index.search("run model")).toEqual([node.id]);
  });

  it("handles empty queries, case-insensitive queries, limits, and stable ordering", () => {
    const index = createSearchIndex();
    const secondNode: CodeNode = {
      ...node,
      id: "symbol:src/extension/model/modelRunner.ts:function:createModelRunner:1",
      name: "createModelRunner",
      qualifiedName: "src/extension/model/modelRunner.ts::createModelRunner",
      filePath: "src/extension/model/modelRunner.ts",
      startLine: 1,
      endLine: 4,
    };

    index.addNode(node);
    index.addNode(secondNode);

    expect(index.search("")).toEqual([]);
    expect(index.search("CONFIGURED RUNNER", 1)).toEqual([node.id]);
    expect(index.search("model", 1)).toEqual([node.id]);
    expect(index.search("model")).toEqual([node.id, secondNode.id]);
  });

  it("prioritizes qualified class method matches over nearby factory names", () => {
    const index = createSearchIndex();
    const methodNode: CodeNode = {
      ...node,
      id: "symbol:src/extension.ts:method:startRun:89",
      kind: "method",
      name: "startRun",
      qualifiedName: "src/extension.ts::LoopAgentChatViewProvider.startRun",
      filePath: "src/extension.ts",
      startLine: 89,
      endLine: 108,
    };
    const factoryNode: CodeNode = {
      ...node,
      id: "symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49",
      name: "createVsCodeWorkspaceIntelligence",
      qualifiedName: "src/extension/intelligence/vscodeWorkspaceIntelligence.ts::createVsCodeWorkspaceIntelligence",
      filePath: "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
      startLine: 49,
      endLine: 140,
    };

    index.addNode(factoryNode);
    index.addNode(methodNode);

    expect(index.search("extension.ts LoopAgentChatViewProvider.startRun", 1)).toEqual([methodNode.id]);
  });
});
