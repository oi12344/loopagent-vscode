import type { CodeEdge } from "./graphTypes";

/**
 * 对边进行智能排序，确保最相关的边优先保留
 *
 * 排序策略：
 * 1. 入口节点相关的边优先（查询主体）
 * 2. 调用关系优先于类型依赖（更直接影响执行流）
 */
export function rankEdges(edges: CodeEdge[], entryNodeIds: Set<string>): CodeEdge[] {
  return [...edges].sort((a, b) => {
    // 1. 入口节点相关的边优先
    const aRelevant = entryNodeIds.has(a.source) || entryNodeIds.has(a.target);
    const bRelevant = entryNodeIds.has(b.source) || entryNodeIds.has(b.target);
    if (aRelevant !== bRelevant) {
      return bRelevant ? 1 : -1;
    }

    // 2. 调用关系 > 类型依赖
    const aWeight = getEdgeWeight(a.kind);
    const bWeight = getEdgeWeight(b.kind);
    return bWeight - aWeight;
  });
}

function getEdgeWeight(kind: string): number {
  switch (kind) {
    case "calls":
      return 3;
    case "extends":
    case "implements":
      return 2;
    case "imports":
    case "references":
      return 1;
    default:
      return 0;
  }
}
