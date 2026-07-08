import type { CodeEdge, CodeNode } from "./graphTypes";
import type { SemanticGraph } from "./semanticGraph";

export type ExpandedSubgraph = {
  nodes: CodeNode[];
  edges: CodeEdge[];
};

export function expandFromNodes(graph: SemanticGraph, roots: CodeNode[], depth = 1): ExpandedSubgraph {
  const nodes = new Map<string, CodeNode>();
  const edges = new Map<string, CodeEdge>();
  const queue: Array<{ node: CodeNode; depth: number }> = roots.map((node) => ({ node, depth: 0 }));

  for (const root of roots) {
    nodes.set(root.id, root);
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || item.depth >= depth) {
      continue;
    }

    for (const edge of graph.getOutgoingEdges(item.node.id)) {
      const target = graph.getNode(edge.target);
      if (!target) {
        continue;
      }

      edges.set(edge.id, edge);
      if (!nodes.has(target.id)) {
        nodes.set(target.id, target);
        queue.push({ node: target, depth: item.depth + 1 });
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
