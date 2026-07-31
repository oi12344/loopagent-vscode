import { describe, it, expect } from "vitest";
import { rankEdges } from "../src/extension/intelligence/graph/edgeRanking";
import type { CodeEdge } from "../src/extension/intelligence/graph/graphTypes";

describe("rankEdges", () => {
  it("should prioritize edges connected to entry nodes", () => {
    const edges: CodeEdge[] = [
      {
        id: "e1",
        source: "node1",
        target: "node2",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e2",
        source: "node3",
        target: "node4",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e3",
        source: "entryNode",
        target: "node5",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
    ];

    const entryNodeIds = new Set(["entryNode"]);
    const ranked = rankEdges(edges, entryNodeIds);

    // 入口节点相关的边应该排在前面
    expect(ranked[0].id).toBe("e3");
  });

  it("should prioritize calls over other edge types", () => {
    const edges: CodeEdge[] = [
      {
        id: "e1",
        source: "node1",
        target: "node2",
        kind: "imports",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e2",
        source: "node3",
        target: "node4",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e3",
        source: "node5",
        target: "node6",
        kind: "references",
        confidence: "high",
        filePath: "test.ts",
      },
    ];

    const entryNodeIds = new Set<string>();
    const ranked = rankEdges(edges, entryNodeIds);

    // calls 应该排在最前面
    expect(ranked[0].kind).toBe("calls");
  });

  it("should combine entry node priority with edge type priority", () => {
    const edges: CodeEdge[] = [
      {
        id: "e1",
        source: "node1",
        target: "node2",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e2",
        source: "entryNode",
        target: "node3",
        kind: "imports",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e3",
        source: "entryNode",
        target: "node4",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
    ];

    const entryNodeIds = new Set(["entryNode"]);
    const ranked = rankEdges(edges, entryNodeIds);

    // 入口节点的 calls 边应该排在最前面
    expect(ranked[0].id).toBe("e3");
    // 入口节点的 imports 边排第二
    expect(ranked[1].id).toBe("e2");
    // 非入口节点的 calls 边排第三
    expect(ranked[2].id).toBe("e1");
  });

  it("should not mutate the original array", () => {
    const edges: CodeEdge[] = [
      {
        id: "e1",
        source: "node1",
        target: "node2",
        kind: "calls",
        confidence: "high",
        filePath: "test.ts",
      },
      {
        id: "e2",
        source: "node3",
        target: "node4",
        kind: "imports",
        confidence: "high",
        filePath: "test.ts",
      },
    ];

    const originalOrder = edges.map((e) => e.id);
    const entryNodeIds = new Set<string>();
    rankEdges(edges, entryNodeIds);

    // 原数组顺序不变
    expect(edges.map((e) => e.id)).toEqual(originalOrder);
  });
});
