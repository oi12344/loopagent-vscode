import { describe, expect, it } from "vitest";

import {
  getField,
  getNearestAncestor,
  readStringLiteral,
  toCodeRange,
  visitNamedNodes,
} from "../../src/extension/intelligence/languages/treeSitterAst";
import type { SyntaxNode } from "../../src/extension/intelligence/parser/parserRuntime";

type SyntaxNodeOptions = {
  text?: string;
  hasError?: boolean;
  startPosition?: { row: number; column: number };
  endPosition?: { row: number; column: number };
  fields?: Record<string, SyntaxNode>;
};

function createSyntaxNode(
  type: string,
  namedChildren: readonly SyntaxNode[] = [],
  options: SyntaxNodeOptions = {},
): SyntaxNode {
  const fields = options.fields ?? {};
  return {
    type,
    text: options.text ?? "",
    isNamed: true,
    hasError: options.hasError ?? false,
    startPosition: options.startPosition ?? { row: 0, column: 0 },
    endPosition: options.endPosition ?? { row: 0, column: 0 },
    namedChildren,
    childForFieldName: (name) => fields[name] ?? null,
  };
}

describe("Tree-sitter AST helpers", () => {
  it("visits named nodes with their ancestor chain", () => {
    const method = createSyntaxNode("method_definition");
    const classBody = createSyntaxNode("class_body", [method]);
    const root = createSyntaxNode("program", [classBody]);
    const visited: string[] = [];

    visitNamedNodes(root, (node, ancestors) => {
      visited.push(`${ancestors.map((ancestor) => ancestor.type).join("/")}->${node.type}`);
    });

    expect(visited).toContain("program/class_body->method_definition");
  });

  it("converts zero-based syntax positions into code ranges", () => {
    const node = createSyntaxNode("function_declaration", [], {
      startPosition: { row: 2, column: 4 },
      endPosition: { row: 7, column: 1 },
    });

    expect(toCodeRange(node)).toEqual({
      startLine: 3,
      endLine: 8,
      startColumn: 4,
      endColumn: 1,
    });
  });

  it("reads fields, ancestors, and quoted string values", () => {
    const source = createSyntaxNode("string", [], { text: '"./runner"' });
    const importNode = createSyntaxNode("import_statement", [source], { fields: { source } });

    expect(getField(importNode, "source")).toBe(source);
    expect(getNearestAncestor([importNode, source], (node) => node.type === "import_statement")).toBe(importNode);
    expect(readStringLiteral(source)).toBe("./runner");
  });
});
