import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { SemanticGraph } from "../graph/semanticGraph";

export type ResolveReferencesOptions = {
  graph: SemanticGraph;
  references: UnresolvedReference[];
  importBindings: ImportBinding[];
};

export function resolveReferences({ graph, references, importBindings }: ResolveReferencesOptions): CodeEdge[] {
  const resolvedEdges: CodeEdge[] = [];

  for (const reference of references) {
    const target = findTargetNode(graph, reference, importBindings);
    if (!target) {
      continue;
    }

    resolvedEdges.push({
      id: `edge:${reference.fromNodeId}:${reference.referenceKind}:${target.id}:${reference.line}`,
      source: reference.fromNodeId,
      target: target.id,
      kind: reference.referenceKind,
      filePath: reference.filePath,
      line: reference.line,
      column: reference.column,
      confidence: "exact",
    });
  }

  return resolvedEdges;
}

function findTargetNode(
  graph: SemanticGraph,
  reference: UnresolvedReference,
  importBindings: ImportBinding[],
): CodeNode | undefined {
  const imported = importBindings.find(
    (binding) => binding.filePath === reference.filePath && binding.localName === reference.referenceName,
  );

  if (imported?.resolvedFilePath) {
    return graph
      .getAllNodes()
      .find((node) => node.filePath === imported.resolvedFilePath && node.name === imported.importedName);
  }

  const sameFile = graph
    .getNodesByName(reference.referenceName)
    .find((node) => node.filePath === reference.filePath);
  if (sameFile) {
    return sameFile;
  }

  const candidates = graph.getNodesByName(reference.referenceName);
  return candidates.length === 1 ? candidates[0] : undefined;
}
