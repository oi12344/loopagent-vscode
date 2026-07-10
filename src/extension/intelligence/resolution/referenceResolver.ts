import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { SemanticGraph } from "../graph/semanticGraph";

export type ResolveReferencesOptions = {
  graph: SemanticGraph;
  references: UnresolvedReference[];
  importBindings: ImportBinding[];
};

type ResolvedTarget = {
  node: CodeNode;
  confidence: CodeEdge["confidence"];
};

export function resolveReferences({ graph, references, importBindings }: ResolveReferencesOptions): CodeEdge[] {
  const resolvedEdges: CodeEdge[] = [];

  for (const reference of references) {
    const target = findTargetNode(graph, reference, importBindings);
    if (!target) {
      continue;
    }

    resolvedEdges.push({
      id: `edge:${reference.fromNodeId}:${reference.referenceKind}:${target.node.id}:${reference.line}`,
      source: reference.fromNodeId,
      target: target.node.id,
      kind: reference.referenceKind,
      filePath: reference.filePath,
      line: reference.line,
      column: reference.column,
      confidence: applyConfidenceHint(target.confidence, reference.confidenceHint),
    });
  }

  return resolvedEdges;
}

function findTargetNode(
  graph: SemanticGraph,
  reference: UnresolvedReference,
  importBindings: ImportBinding[],
): ResolvedTarget | undefined {
  if (reference.calleeKind && reference.calleeKind !== "identifier") {
    return undefined;
  }

  const imported = importBindings.find(
    (binding) => binding.filePath === reference.filePath && binding.localName === reference.referenceName,
  );

  if (imported?.resolvedFilePath) {
    const target = graph
      .getAllNodes()
      .find((node) => node.filePath === imported.resolvedFilePath && isImportedTarget(node, imported));
    return target ? { node: target, confidence: "exact" } : undefined;
  }

  const sameFile = graph
    .getNodesByName(reference.referenceName)
    .find((node) => node.filePath === reference.filePath);
  if (sameFile) {
    return { node: sameFile, confidence: "probable" };
  }

  const candidates = graph.getNodesByName(reference.referenceName);
  return candidates.length === 1 ? { node: candidates[0]!, confidence: "heuristic" } : undefined;
}

function isImportedTarget(node: CodeNode, binding: ImportBinding): boolean {
  if (binding.importedName === "default") {
    return node.metadata?.isDefaultExport === true;
  }
  return node.name === binding.importedName;
}

function applyConfidenceHint(
  resolvedConfidence: CodeEdge["confidence"],
  hint: CodeEdge["confidence"] | undefined,
): CodeEdge["confidence"] {
  if (!hint) {
    return resolvedConfidence;
  }
  const rank: Record<CodeEdge["confidence"], number> = { heuristic: 0, probable: 1, exact: 2 };
  return rank[hint] < rank[resolvedConfidence] ? hint : resolvedConfidence;
}
