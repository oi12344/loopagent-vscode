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
    const target = preferConcreteNode(
      graph
        .getAllNodes()
        .filter((node) => node.filePath === imported.resolvedFilePath && isImportedTarget(node, imported)),
    );
    return target ? { node: target, confidence: "exact" } : undefined;
  }

  const namedCandidates = graph.getNodesByName(reference.referenceName);
  const sameFile = preferConcreteNode(namedCandidates.filter((node) => node.filePath === reference.filePath));
  if (sameFile) {
    return { node: sameFile, confidence: "probable" };
  }

  const concreteCandidates = namedCandidates.filter((node) => node.metadata?.declarationOnly !== true);
  const candidates = concreteCandidates.length > 0 ? concreteCandidates : namedCandidates;
  return candidates.length === 1 ? { node: candidates[0]!, confidence: "heuristic" } : undefined;
}

function preferConcreteNode(nodes: CodeNode[]): CodeNode | undefined {
  return nodes.find((node) => node.metadata?.declarationOnly !== true) ?? nodes[0];
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
