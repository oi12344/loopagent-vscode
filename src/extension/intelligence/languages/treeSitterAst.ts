import type { SyntaxNode } from "../parser/parserRuntime";

export type SyntaxVisitor = (node: SyntaxNode, ancestors: readonly SyntaxNode[]) => void;

export type CodeRange = {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
};

export function visitNamedNodes(
  node: SyntaxNode,
  visitor: SyntaxVisitor,
  ancestors: readonly SyntaxNode[] = [],
): void {
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const child of node.namedChildren) {
    visitNamedNodes(child, visitor, nextAncestors);
  }
}

export function toCodeRange(node: SyntaxNode): CodeRange {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
}

export function getField(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

export function getNearestAncestor(
  ancestors: readonly SyntaxNode[],
  predicate: (node: SyntaxNode) => boolean,
): SyntaxNode | undefined {
  return [...ancestors].reverse().find(predicate);
}

export function readStringLiteral(node: SyntaxNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  const value = node.text.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
