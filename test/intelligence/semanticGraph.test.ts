import { describe, expect, it } from "vitest";

import { createSemanticGraph } from "../../src/extension/intelligence/graph/semanticGraph";
import type { CodeEdge, CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const fileNode: CodeNode = {
  id: "file:src/a.ts",
  kind: "file",
  name: "a.ts",
  qualifiedName: "src/a.ts",
  filePath: "src/a.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 3,
};

const functionNode: CodeNode = {
  id: "symbol:src/a.ts:function:run:1",
  kind: "function",
  name: "run",
  qualifiedName: "src/a.ts::run",
  filePath: "src/a.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 3,
};

const containsEdge: CodeEdge = {
  id: "edge:file:src/a.ts:contains:symbol:src/a.ts:function:run:1:1",
  source: fileNode.id,
  target: functionNode.id,
  kind: "contains",
  filePath: "src/a.ts",
  line: 1,
  confidence: "exact",
};

describe("SemanticGraph", () => {
  it("stores nodes, deduplicates edges, and exposes incoming/outgoing edges", () => {
    const graph = createSemanticGraph();

    graph.upsertNode(fileNode);
    graph.upsertNode(functionNode);
    graph.upsertEdge(containsEdge);
    graph.upsertEdge(containsEdge);

    expect(graph.getNode(functionNode.id)).toEqual(functionNode);
    expect(graph.getNodesByName("run")).toEqual([functionNode]);
    expect(graph.getOutgoingEdges(fileNode.id)).toEqual([containsEdge]);
    expect(graph.getIncomingEdges(functionNode.id)).toEqual([containsEdge]);
    expect(graph.getAllNodes()).toHaveLength(2);
    expect(graph.getAllEdges()).toHaveLength(1);
  });

  it("removes stale name indexes when a node is renamed", () => {
    const graph = createSemanticGraph();
    const updatedFunctionNode: CodeNode = {
      ...functionNode,
      name: "runAgain",
      qualifiedName: "src/a.ts::runAgain",
    };

    graph.upsertNode(functionNode);
    graph.upsertNode(updatedFunctionNode);

    expect(graph.getNodesByName("run")).toEqual([]);
    expect(graph.getNodesByName("runAgain")).toEqual([updatedFunctionNode]);
  });

  it("replaces existing edges and updates incoming/outgoing indexes", () => {
    const graph = createSemanticGraph();
    const updatedTargetNode: CodeNode = {
      ...functionNode,
      id: "symbol:src/a.ts:function:runAgain:2",
      name: "runAgain",
      qualifiedName: "src/a.ts::runAgain",
      startLine: 2,
    };
    const updatedContainsEdge: CodeEdge = {
      ...containsEdge,
      target: updatedTargetNode.id,
    };

    graph.upsertNode(fileNode);
    graph.upsertNode(functionNode);
    graph.upsertNode(updatedTargetNode);
    graph.upsertEdge(containsEdge);
    graph.upsertEdge(updatedContainsEdge);

    expect(graph.getOutgoingEdges(fileNode.id)).toEqual([updatedContainsEdge]);
    expect(graph.getIncomingEdges(functionNode.id)).toEqual([]);
    expect(graph.getIncomingEdges(updatedTargetNode.id)).toEqual([updatedContainsEdge]);
    expect(graph.getAllEdges()).toHaveLength(1);
  });

  it("keeps node indexes correct when callers mutate and upsert the same node object", () => {
    const graph = createSemanticGraph();
    const mutableFunctionNode: CodeNode = { ...functionNode };
    const updatedFunctionNode: CodeNode = {
      ...mutableFunctionNode,
      name: "runAgain",
      qualifiedName: "src/a.ts::runAgain",
    };

    graph.upsertNode(mutableFunctionNode);
    mutableFunctionNode.name = updatedFunctionNode.name;
    mutableFunctionNode.qualifiedName = updatedFunctionNode.qualifiedName;
    graph.upsertNode(mutableFunctionNode);

    expect(graph.getNodesByName("run")).toEqual([]);
    expect(graph.getNodesByName("runAgain")).toEqual([updatedFunctionNode]);
  });

  it("keeps edge indexes correct when callers mutate and upsert the same edge object", () => {
    const graph = createSemanticGraph();
    const otherFileNode: CodeNode = {
      ...fileNode,
      id: "file:src/b.ts",
      name: "b.ts",
      qualifiedName: "src/b.ts",
      filePath: "src/b.ts",
    };
    const updatedTargetNode: CodeNode = {
      ...functionNode,
      id: "symbol:src/a.ts:function:runAgain:2",
      name: "runAgain",
      qualifiedName: "src/a.ts::runAgain",
      startLine: 2,
    };
    const mutableContainsEdge: CodeEdge = { ...containsEdge };
    const updatedContainsEdge: CodeEdge = {
      ...mutableContainsEdge,
      source: otherFileNode.id,
      target: updatedTargetNode.id,
    };

    graph.upsertNode(fileNode);
    graph.upsertNode(otherFileNode);
    graph.upsertNode(functionNode);
    graph.upsertNode(updatedTargetNode);
    graph.upsertEdge(mutableContainsEdge);
    mutableContainsEdge.source = updatedContainsEdge.source;
    mutableContainsEdge.target = updatedContainsEdge.target;
    graph.upsertEdge(mutableContainsEdge);

    expect(graph.getOutgoingEdges(fileNode.id)).toEqual([]);
    expect(graph.getIncomingEdges(functionNode.id)).toEqual([]);
    expect(graph.getOutgoingEdges(otherFileNode.id)).toEqual([updatedContainsEdge]);
    expect(graph.getIncomingEdges(updatedTargetNode.id)).toEqual([updatedContainsEdge]);
    expect(graph.getAllEdges()).toHaveLength(1);
  });

  it("returns node copies so external mutation cannot corrupt graph state", () => {
    const graph = createSemanticGraph();
    const storedFunctionNode: CodeNode = { ...functionNode };
    const expectedFunctionNode: CodeNode = { ...storedFunctionNode };

    graph.upsertNode(storedFunctionNode);
    const returnedNode = graph.getNode(storedFunctionNode.id);
    if (!returnedNode) {
      throw new Error("Expected node to exist");
    }

    returnedNode.name = "polluted";

    expect(graph.getNode(storedFunctionNode.id)).toEqual(expectedFunctionNode);
    expect(graph.getNodesByName("run")).toEqual([expectedFunctionNode]);
    expect(graph.getNodesByName("polluted")).toEqual([]);
  });

  it("returns edge copies so external mutation cannot corrupt graph state", () => {
    const graph = createSemanticGraph();
    const storedContainsEdge: CodeEdge = { ...containsEdge };
    const expectedContainsEdge: CodeEdge = { ...storedContainsEdge };
    const otherFileNode: CodeNode = {
      ...fileNode,
      id: "file:src/b.ts",
      name: "b.ts",
      qualifiedName: "src/b.ts",
      filePath: "src/b.ts",
    };
    const updatedTargetNode: CodeNode = {
      ...functionNode,
      id: "symbol:src/a.ts:function:runAgain:2",
      name: "runAgain",
      qualifiedName: "src/a.ts::runAgain",
      startLine: 2,
    };

    graph.upsertEdge(storedContainsEdge);
    const returnedEdge = graph.getOutgoingEdges(fileNode.id)[0] as CodeEdge;
    returnedEdge.source = otherFileNode.id;
    returnedEdge.target = updatedTargetNode.id;

    expect(graph.getOutgoingEdges(fileNode.id)).toEqual([expectedContainsEdge]);
    expect(graph.getIncomingEdges(functionNode.id)).toEqual([expectedContainsEdge]);
    expect(graph.getOutgoingEdges(otherFileNode.id)).toEqual([]);
    expect(graph.getIncomingEdges(updatedTargetNode.id)).toEqual([]);
    expect(graph.getAllEdges()).toEqual([expectedContainsEdge]);
  });
});
