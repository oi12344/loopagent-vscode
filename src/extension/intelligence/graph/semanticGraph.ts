import type { CodeEdge, CodeNode } from "./graphTypes";

export type SemanticGraph = {
  upsertNode(node: CodeNode): void;
  upsertEdge(edge: CodeEdge): void;
  getNode(id: string): CodeNode | undefined;
  getNodesByName(name: string): CodeNode[];
  getOutgoingEdges(nodeId: string): CodeEdge[];
  getIncomingEdges(nodeId: string): CodeEdge[];
  getAllNodes(): CodeNode[];
  getAllEdges(): CodeEdge[];
};

export function createSemanticGraph(): SemanticGraph {
  const nodesById = new Map<string, CodeNode>();
  const nodeIdsByName = new Map<string, Set<string>>();
  const edgesById = new Map<string, CodeEdge>();
  const outgoingBySource = new Map<string, Set<string>>();
  const incomingByTarget = new Map<string, Set<string>>();

  function copyNode(node: CodeNode): CodeNode {
    return { ...node };
  }

  function copyEdge(edge: CodeEdge): CodeEdge {
    return { ...edge };
  }

  function addNodeNameIndex(node: CodeNode): void {
    const bucket = nodeIdsByName.get(node.name) ?? new Set<string>();
    bucket.add(node.id);
    nodeIdsByName.set(node.name, bucket);
  }

  function removeNodeNameIndex(node: CodeNode): void {
    const bucket = nodeIdsByName.get(node.name);
    if (!bucket) {
      return;
    }

    bucket.delete(node.id);
    if (bucket.size === 0) {
      nodeIdsByName.delete(node.name);
    }
  }

  function removeEdgeIndexes(edge: CodeEdge): void {
    const outgoing = outgoingBySource.get(edge.source);
    if (outgoing) {
      outgoing.delete(edge.id);
      if (outgoing.size === 0) {
        outgoingBySource.delete(edge.source);
      }
    }

    const incoming = incomingByTarget.get(edge.target);
    if (incoming) {
      incoming.delete(edge.id);
      if (incoming.size === 0) {
        incomingByTarget.delete(edge.target);
      }
    }
  }

  return {
    upsertNode(node) {
      const nodeCopy = copyNode(node);
      const existingNode = nodesById.get(nodeCopy.id);
      if (existingNode && existingNode.name !== nodeCopy.name) {
        removeNodeNameIndex(existingNode);
      }

      nodesById.set(nodeCopy.id, nodeCopy);
      addNodeNameIndex(nodeCopy);
    },
    upsertEdge(edge) {
      const edgeCopy = copyEdge(edge);
      const existingEdge = edgesById.get(edgeCopy.id);
      if (existingEdge) {
        removeEdgeIndexes(existingEdge);
      }

      edgesById.set(edgeCopy.id, edgeCopy);
      const outgoing = outgoingBySource.get(edgeCopy.source) ?? new Set<string>();
      outgoing.add(edgeCopy.id);
      outgoingBySource.set(edgeCopy.source, outgoing);

      const incoming = incomingByTarget.get(edgeCopy.target) ?? new Set<string>();
      incoming.add(edgeCopy.id);
      incomingByTarget.set(edgeCopy.target, incoming);
    },
    getNode(id) {
      const node = nodesById.get(id);
      return node ? copyNode(node) : undefined;
    },
    getNodesByName(name) {
      return [...(nodeIdsByName.get(name) ?? [])]
        .map((id) => nodesById.get(id))
        .filter((node): node is CodeNode => Boolean(node))
        .map(copyNode);
    },
    getOutgoingEdges(nodeId) {
      return [...(outgoingBySource.get(nodeId) ?? [])]
        .map((id) => edgesById.get(id))
        .filter((edge): edge is CodeEdge => Boolean(edge))
        .map(copyEdge);
    },
    getIncomingEdges(nodeId) {
      return [...(incomingByTarget.get(nodeId) ?? [])]
        .map((id) => edgesById.get(id))
        .filter((edge): edge is CodeEdge => Boolean(edge))
        .map(copyEdge);
    },
    getAllNodes() {
      return [...nodesById.values()].map(copyNode);
    },
    getAllEdges() {
      return [...edgesById.values()].map(copyEdge);
    },
  };
}
