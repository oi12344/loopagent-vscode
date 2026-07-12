import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource, SyntaxNode } from "../parser/parserRuntime";
import type { ExtractionResult } from "./languageAdapter";
import { getField, getNearestAncestor, getSyntaxTreeDiagnostics, toCodeRange, visitNamedNodes } from "./treeSitterAst";

type Callee = {
  referenceName: string;
  calleeKind: NonNullable<UnresolvedReference["calleeKind"]>;
  receiverName?: string;
};

export function extractPythonAst(parsed: ParsedSource): ExtractionResult {
  const tree = parsed.tree;
  if (!tree) {
    throw new Error("Python AST extraction requires a syntax tree.");
  }

  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const codeNodeBySyntaxNode = new Map<SyntaxNode, CodeNode>();

  visitNamedNodes(tree.rootNode, (node, ancestors) => {
    switch (node.type) {
      case "class_definition":
        addClass(node, ancestors);
        break;
      case "function_definition":
        addFunctionOrMethod(node, ancestors);
        break;
      case "import_from_statement":
        importBindings.push(...extractFromImports(node, parsed));
        break;
      case "import_statement":
        importBindings.push(...extractModuleImports(node, parsed));
        break;
      case "call":
        addCallReference(node, ancestors);
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

  function addClass(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    if (getNearestContainer(ancestors)) {
      return;
    }
    const name = getField(node, "name")?.text;
    if (!name) {
      return;
    }
    const classNode = createSymbolNode(parsed, node, "class", name);
    nodes.push(classNode);
    edges.push(createEdge(fileNode.id, classNode.id, "contains", parsed.filePath, classNode.startLine));
    codeNodeBySyntaxNode.set(node, classNode);
  }

  function addFunctionOrMethod(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const nearestContainer = getNearestContainer(ancestors);
    if (nearestContainer?.type === "function_definition") {
      return;
    }
    const name = getField(node, "name")?.text;
    if (!name) {
      return;
    }

    const classNode = nearestContainer ? codeNodeBySyntaxNode.get(nearestContainer) : undefined;
    const kind: CodeNode["kind"] = classNode ? "method" : "function";
    const decoratedDefinition = getNearestAncestor(
      ancestors,
      (ancestor) => {
        if (ancestor.type !== "decorated_definition") {
          return false;
        }
        const definition = getField(ancestor, "definition");
        return Boolean(definition && isSameSyntaxNode(definition, node));
      },
    );
    const metadata = decoratedDefinition
      ? { decoratorStartLine: toCodeRange(decoratedDefinition).startLine }
      : undefined;
    const qualifiedName = classNode ? `${classNode.qualifiedName}.${name}` : `${parsed.filePath}::${name}`;
    const codeNode = createSymbolNode(parsed, node, kind, name, qualifiedName, metadata);
    nodes.push(codeNode);
    edges.push(
      createEdge(classNode?.id ?? fileNode.id, codeNode.id, "contains", parsed.filePath, codeNode.startLine),
    );
    codeNodeBySyntaxNode.set(node, codeNode);
  }

  function addCallReference(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const owner = getCallOwner(ancestors);
    const functionNode = getField(node, "function");
    const callee = describeCallee(functionNode);
    if (!owner || !callee || !functionNode) {
      return;
    }
    const range = toCodeRange(functionNode);
    unresolvedReferences.push({
      fromNodeId: owner.id,
      referenceName: callee.referenceName,
      referenceKind: "calls",
      filePath: parsed.filePath,
      line: range.startLine,
      column: range.startColumn,
      languageId: parsed.languageId,
      calleeKind: callee.calleeKind,
      receiverName: callee.receiverName,
    });
  }

  function getCallOwner(ancestors: readonly SyntaxNode[]): CodeNode | undefined {
    const functionNode = getNearestAncestor(ancestors, (ancestor) => ancestor.type === "function_definition");
    return functionNode ? codeNodeBySyntaxNode.get(functionNode) : fileNode;
  }
}

function getNearestContainer(ancestors: readonly SyntaxNode[]): SyntaxNode | undefined {
  return getNearestAncestor(
    ancestors,
    (ancestor) => ancestor.type === "function_definition" || ancestor.type === "class_definition",
  );
}

function describeCallee(node: SyntaxNode | undefined): Callee | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier") {
    return { referenceName: node.text, calleeKind: "identifier" };
  }
  if (node.type === "attribute") {
    const object = getField(node, "object")?.text;
    const attribute = getField(node, "attribute")?.text;
    if (attribute) {
      return { referenceName: attribute, calleeKind: "member", receiverName: object };
    }
  }
  return { referenceName: node.text, calleeKind: "dynamic" };
}

function extractFromImports(node: SyntaxNode, parsed: ParsedSource): ImportBinding[] {
  const sourceNode = getField(node, "module_name");
  const source = sourceNode?.text;
  if (!source) {
    return [];
  }
  return node.namedChildren
    .filter((child) => !isSameSyntaxNode(child, sourceNode))
    .flatMap((child) => collectImportedNames(child))
    .map(({ importedName, localName }) => ({
      filePath: parsed.filePath,
      localName,
      importedName,
      source,
      languageId: parsed.languageId,
    }));
}

function isSameSyntaxNode(left: SyntaxNode, right: SyntaxNode): boolean {
  return (
    left.type === right.type &&
    left.startPosition.row === right.startPosition.row &&
    left.startPosition.column === right.startPosition.column &&
    left.endPosition.row === right.endPosition.row &&
    left.endPosition.column === right.endPosition.column
  );
}

function extractModuleImports(node: SyntaxNode, parsed: ParsedSource): ImportBinding[] {
  return node.namedChildren.flatMap((child) => {
    const names = collectImportedNames(child);
    return names.map(({ importedName, localName }) => ({
      filePath: parsed.filePath,
      localName: child.type === "aliased_import" ? localName : importedName.split(".")[0]!,
      importedName,
      source: importedName,
      languageId: parsed.languageId,
    }));
  });
}

function collectImportedNames(node: SyntaxNode): Array<{ importedName: string; localName: string }> {
  if (node.type === "aliased_import") {
    const importedName = getField(node, "name")?.text;
    const localName = getField(node, "alias")?.text ?? importedName;
    return importedName && localName ? [{ importedName, localName }] : [];
  }
  if (node.type === "dotted_name" || node.type === "identifier") {
    return [{ importedName: node.text, localName: node.text }];
  }
  if (node.type === "wildcard_import") {
    return [{ importedName: "*", localName: "*" }];
  }
  return node.namedChildren.flatMap((child) => collectImportedNames(child));
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

function createSymbolNode(
  parsed: ParsedSource,
  syntaxNode: SyntaxNode,
  kind: CodeNode["kind"],
  name: string,
  qualifiedName = `${parsed.filePath}::${name}`,
  metadata?: Record<string, unknown>,
): CodeNode {
  const range = toCodeRange(syntaxNode);
  return {
    id: `symbol:${parsed.filePath}:${kind}:${name}:${range.startLine}:${range.startColumn}`,
    kind,
    name,
    qualifiedName,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    ...range,
    isExported: false,
    metadata,
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
