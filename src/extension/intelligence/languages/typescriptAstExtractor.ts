import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource, SyntaxNode } from "../parser/parserRuntime";
import type { ExtractionResult } from "./languageAdapter";
import {
  getField,
  getNearestAncestor,
  getSyntaxTreeDiagnostics,
  readStringLiteral,
  toCodeRange,
  visitNamedNodes,
} from "./treeSitterAst";

const FUNCTION_NODE_TYPES = new Set(["function_declaration", "generator_function_declaration", "function_signature"]);
const VARIABLE_FUNCTION_NODE_TYPES = new Set(["arrow_function", "function_expression"]);
const CALLABLE_NODE_TYPES = new Set([...FUNCTION_NODE_TYPES, ...VARIABLE_FUNCTION_NODE_TYPES, "method_definition"]);

type Callee = {
  referenceName: string;
  calleeKind: NonNullable<UnresolvedReference["calleeKind"]>;
  receiverName?: string;
};

export function extractTypeScriptAst(parsed: ParsedSource): ExtractionResult {
  const tree = parsed.tree;
  if (!tree) {
    throw new Error("TypeScript AST extraction requires a syntax tree.");
  }

  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const codeNodeBySyntaxNode = new Map<SyntaxNode, CodeNode>();

  visitNamedNodes(tree.rootNode, (node, ancestors) => {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      addFunction(node, ancestors);
      return;
    }
    if (VARIABLE_FUNCTION_NODE_TYPES.has(node.type)) {
      addVariableFunction(node, ancestors);
      return;
    }

    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration":
        addTopLevelDeclaration(node, "class", ancestors);
        break;
      case "method_definition":
        addMethod(node, ancestors);
        break;
      case "method_signature":
      case "abstract_method_signature":
        addMethod(node, ancestors);
        break;
      case "interface_declaration":
        addTopLevelDeclaration(node, "interface", ancestors);
        break;
      case "type_alias_declaration":
        addTopLevelDeclaration(node, "type", ancestors);
        break;
      case "enum_declaration":
        addTopLevelDeclaration(node, "enum", ancestors);
        break;
      case "import_statement":
        importBindings.push(...extractImportBindings(node, parsed));
        break;
      case "call_expression":
        addReference(node, ancestors, "calls", "function");
        break;
      case "new_expression":
        addReference(node, ancestors, "instantiates", "constructor");
        break;
    }
  });

  return {
    nodes,
    edges,
    importBindings,
    unresolvedReferences,
    diagnostics: getSyntaxTreeDiagnostics(parsed),
  };

  function addFunction(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    if (getNearestCallableSyntaxNode(ancestors)) {
      return;
    }
    const name = getField(node, "name")?.text;
    if (!name) {
      return;
    }
    addNode(node, "function", name, ancestors, fileNode);
  }

  function addVariableFunction(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    if (getNearestCallableSyntaxNode(ancestors)) {
      return;
    }
    const declaration = getNearestAncestor(ancestors, (ancestor) => ancestor.type === "variable_declarator");
    const name = declaration ? getField(declaration, "name")?.text : undefined;
    if (!name) {
      return;
    }
    addNode(node, "function", name, ancestors, fileNode, declaration);
  }

  function addTopLevelDeclaration(
    node: SyntaxNode,
    kind: Extract<CodeNode["kind"], "class" | "interface" | "type" | "enum">,
    ancestors: readonly SyntaxNode[],
  ): void {
    const name = getField(node, "name")?.text;
    if (!name) {
      return;
    }
    addNode(node, kind, name, ancestors, fileNode);
  }

  function addMethod(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const classSyntaxNode = getNearestAncestor(
      ancestors,
      (ancestor) =>
        ancestor.type === "class_declaration" ||
        ancestor.type === "abstract_class_declaration" ||
        ancestor.type === "interface_declaration",
    );
    const classNode = classSyntaxNode ? codeNodeBySyntaxNode.get(classSyntaxNode) : undefined;
    const name = getField(node, "name")?.text;
    if (!classNode || !name) {
      return;
    }
    const kind: CodeNode["kind"] = name === "constructor" ? "constructor" : "method";
    addNode(node, kind, name, ancestors, classNode, undefined, `${classNode.qualifiedName}.${name}`);
  }

  function addNode(
    rangeNode: SyntaxNode,
    kind: CodeNode["kind"],
    name: string,
    ancestors: readonly SyntaxNode[],
    parentNode: CodeNode,
    identityNode: SyntaxNode = rangeNode,
    qualifiedName = `${parsed.filePath}::${name}`,
  ): void {
    const range = toCodeRange(rangeNode);
    const exported = parentNode.kind === "file" && isExported(ancestors);
    const codeNode: CodeNode = {
      id: `symbol:${parsed.filePath}:${kind}:${name}:${range.startLine}:${range.startColumn}`,
      kind,
      name,
      qualifiedName,
      filePath: parsed.filePath,
      languageId: parsed.languageId,
      ...range,
      signature: createCallableSignature(rangeNode, name),
      isExported: exported,
      metadata: createNodeMetadata(identityNode, ancestors),
    };
    nodes.push(codeNode);
    edges.push(createEdge(parentNode.id, codeNode.id, "contains", parsed.filePath, range.startLine));
    codeNodeBySyntaxNode.set(identityNode, codeNode);
    if (identityNode !== rangeNode) {
      codeNodeBySyntaxNode.set(rangeNode, codeNode);
    }
  }

  function addReference(
    node: SyntaxNode,
    ancestors: readonly SyntaxNode[],
    referenceKind: UnresolvedReference["referenceKind"],
    fieldName: "function" | "constructor",
  ): void {
    const owner = getCallOwner(ancestors);
    const calleeNode = getField(node, fieldName);
    const callee = describeCallee(calleeNode);
    if (!owner || !callee || !calleeNode) {
      return;
    }
    const range = toCodeRange(calleeNode);
    unresolvedReferences.push({
      fromNodeId: owner.id,
      referenceName: callee.referenceName,
      referenceKind,
      filePath: parsed.filePath,
      line: range.startLine,
      column: range.startColumn,
      languageId: parsed.languageId,
      calleeKind: callee.calleeKind,
      receiverName: callee.receiverName,
    });
  }

  function getCallOwner(ancestors: readonly SyntaxNode[]): CodeNode | undefined {
    const callable = getNearestCallableSyntaxNode(ancestors);
    return callable ? codeNodeBySyntaxNode.get(callable) : fileNode;
  }
}

function createNodeMetadata(node: SyntaxNode, ancestors: readonly SyntaxNode[]): CodeNode["metadata"] {
  const metadata: Record<string, unknown> = {};
  if (isDefaultExport(ancestors)) metadata.isDefaultExport = true;
  if (node.type === "function_signature" || node.type === "method_signature" || node.type === "abstract_method_signature") {
    metadata.declarationOnly = true;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function createCallableSignature(node: SyntaxNode, name: string): string | undefined {
  if (
    !CALLABLE_NODE_TYPES.has(node.type) &&
    node.type !== "function_signature" &&
    node.type !== "method_signature" &&
    node.type !== "abstract_method_signature"
  ) {
    return undefined;
  }
  const typeParameters = getField(node, "type_parameters")?.text ?? "";
  const parameters = getField(node, "parameters")?.text;
  const returnType = getField(node, "return_type")?.text ?? "";
  if (!parameters) {
    return undefined;
  }
  return `${name}${typeParameters}${parameters}${returnType}`.trim().replace(/\s+/g, " ");
}

function getNearestCallableSyntaxNode(ancestors: readonly SyntaxNode[]): SyntaxNode | undefined {
  return getNearestAncestor(ancestors, (ancestor) => CALLABLE_NODE_TYPES.has(ancestor.type));
}

function describeCallee(node: SyntaxNode | undefined): Callee | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier" || node.type === "type_identifier") {
    return { referenceName: node.text, calleeKind: "identifier" };
  }
  if (node.type === "member_expression") {
    const object = getField(node, "object")?.text;
    const property = getField(node, "property")?.text;
    if (property) {
      return { referenceName: property, calleeKind: "member", receiverName: object };
    }
  }
  return { referenceName: node.text, calleeKind: "dynamic" };
}

function extractImportBindings(node: SyntaxNode, parsed: ParsedSource): ImportBinding[] {
  const source = readStringLiteral(getField(node, "source"));
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!source || !clause) {
    return [];
  }

  const bindings: ImportBinding[] = [];
  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      bindings.push(createImportBinding(parsed, source, child.text, "default", { isDefault: true }));
      continue;
    }
    if (child.type === "namespace_import") {
      const localName = child.namedChildren.find((candidate) => candidate.type === "identifier")?.text;
      if (localName) {
        bindings.push(createImportBinding(parsed, source, localName, "*", { isNamespace: true }));
      }
      continue;
    }
    if (child.type === "named_imports") {
      for (const specifier of child.namedChildren.filter((candidate) => candidate.type === "import_specifier")) {
        const importedName = getField(specifier, "name")?.text;
        const localName = getField(specifier, "alias")?.text ?? importedName;
        if (importedName && localName) {
          bindings.push(createImportBinding(parsed, source, localName, importedName));
        }
      }
    }
  }
  return bindings;
}

function createImportBinding(
  parsed: ParsedSource,
  source: string,
  localName: string,
  importedName: string,
  options: Pick<ImportBinding, "isDefault" | "isNamespace"> = {},
): ImportBinding {
  return {
    filePath: parsed.filePath,
    localName,
    importedName,
    source,
    languageId: parsed.languageId,
    ...options,
  };
}

function isExported(ancestors: readonly SyntaxNode[]): boolean {
  return ancestors.some((ancestor) => ancestor.type === "export_statement");
}

function isDefaultExport(ancestors: readonly SyntaxNode[]): boolean {
  return ancestors.some(
    (ancestor) => ancestor.type === "export_statement" && /^\s*export\s+default\b/.test(ancestor.text),
  );
}

function createFileNode(parsed: ParsedSource): CodeNode {
  return {
    id: `file:${parsed.filePath}`,
    kind: "file",
    name: parsed.filePath.split(/[\\/]/).at(-1) ?? parsed.filePath,
    qualifiedName: parsed.filePath,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: 1,
    endLine: Math.max(1, parsed.text.split(/\r?\n/).length),
  };
}

function createEdge(source: string, target: string, kind: CodeEdge["kind"], filePath: string, line: number): CodeEdge {
  return {
    id: `edge:${source}:${kind}:${target}:${line}`,
    source,
    target,
    kind,
    filePath,
    line,
    confidence: "exact",
  };
}
