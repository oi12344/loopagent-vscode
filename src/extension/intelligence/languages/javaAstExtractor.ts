import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource, SyntaxNode } from "../parser/parserRuntime";
import type { ExtractionResult } from "./languageAdapter";
import {
  getField,
  getNearestAncestor,
  getSyntaxTreeDiagnostics,
  toCodeRange,
  visitNamedNodes,
} from "./treeSitterAst";

/**
 * 从 Tree-sitter 解析的 Java AST 中提取代码图信息
 */
export function extractJavaAst(parsed: ParsedSource): ExtractionResult {
  if (!parsed.tree) {
    throw new Error("Tree-sitter parse tree is required for Java AST extraction");
  }

  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const codeNodeBySyntaxNode = new Map<SyntaxNode, CodeNode>();

  let currentPackage = "";

  visitNamedNodes(parsed.tree.rootNode, (node, ancestors) => {
    switch (node.type) {
      case "package_declaration":
        extractPackage(node);
        break;
      case "import_declaration":
        extractImport(node);
        break;
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
        addClassLikeDeclaration(node, ancestors);
        break;
      case "method_declaration":
      case "constructor_declaration":
        addMethod(node, ancestors);
        break;
      case "field_declaration":
        addField(node, ancestors);
        break;
      case "method_invocation":
        addMethodReference(node, ancestors);
        break;
      case "type_identifier":
        addTypeReference(node, ancestors);
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

  function createFileNode(parsed: ParsedSource): CodeNode {
    return {
      id: `file://${parsed.filePath}`,
      kind: "module",
      name: parsed.filePath.split(/[/\\]/).pop() ?? parsed.filePath,
      qualifiedName: parsed.filePath,
      filePath: parsed.filePath,
      languageId: parsed.languageId,
      startLine: 1,
      endLine: Math.max(1, parsed.text.split(/\r?\n/).length),
    };
  }

  function extractPackage(node: SyntaxNode): void {
    const nameNode = getField(node, "name");
    if (nameNode) {
      currentPackage = nameNode.text;
    }
  }

  function extractImport(node: SyntaxNode): void {
    // import com.example.Class; 或 import com.example.*;
    const importPath = node.namedChildren
      .filter((child) => child.type === "scoped_identifier" || child.type === "identifier")
      .map((child) => child.text)
      .join("");

    if (importPath) {
      const parts = importPath.split(".");
      const importedName = parts[parts.length - 1];

      if (importedName !== "*") {
        const range = toCodeRange(node);
        importBindings.push({
          localName: importedName,
          importedName,
          source: importPath,
          filePath: parsed.filePath,
          languageId: parsed.languageId,
        });
      }
    }
  }

  function addClassLikeDeclaration(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const nameNode = getField(node, "name");
    if (!nameNode) return;

    const className = nameNode.text;
    const fqn = currentPackage ? `${currentPackage}.${className}` : className;
    const range = toCodeRange(node);

    const classNode: CodeNode = {
      id: fqn,
      kind: "class",
      name: className,
      qualifiedName: fqn,
      filePath: parsed.filePath,
      languageId: parsed.languageId,
      startLine: range.startLine,
      endLine: range.endLine,
    };

    nodes.push(classNode);
    codeNodeBySyntaxNode.set(node, classNode);

    // 连接到父容器（文件或外部类）
    const parentClassNode = getNearestAncestor(ancestors, (n) =>
      n.type === "class_declaration" ||
      n.type === "interface_declaration" ||
      n.type === "enum_declaration"
    );
    const parentNode = parentClassNode ? codeNodeBySyntaxNode.get(parentClassNode) : fileNode;

    if (parentNode) {
      edges.push({
        id: `edge:${parentNode.id}:contains:${fqn}:${range.startLine}`,
        source: parentNode.id,
        target: fqn,
        kind: "contains",
        filePath: parsed.filePath,
        line: range.startLine,
        confidence: "exact",
      });
    }
  }

  function addMethod(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const nameNode = getField(node, "name");
    if (!nameNode) return;

    const methodName = nameNode.text;
    const parentClassNode = getNearestAncestor(ancestors, (n) =>
      n.type === "class_declaration" ||
      n.type === "interface_declaration" ||
      n.type === "enum_declaration"
    );

    if (!parentClassNode) return;

    const parentNode = codeNodeBySyntaxNode.get(parentClassNode);
    if (!parentNode) return;

    const fqn = `${parentNode.id}.${methodName}`;
    const range = toCodeRange(node);

    const nodeId = `${fqn}:${range.startLine}:${range.startColumn}`;
    const methodNode: CodeNode = {
      id: nodeId,
      kind: "function",
      name: methodName,
      qualifiedName: fqn,
      filePath: parsed.filePath,
      languageId: parsed.languageId,
      startLine: range.startLine,
      endLine: range.endLine,
    };

    nodes.push(methodNode);
    codeNodeBySyntaxNode.set(node, methodNode);

    edges.push({
      id: `edge:${parentNode.id}:contains:${nodeId}`,
      source: parentNode.id,
      target: nodeId,
      kind: "contains",
      filePath: parsed.filePath,
      line: range.startLine,
      confidence: "exact",
    });
  }

  function addField(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const declaratorNode = node.namedChildren.find((child) => child.type === "variable_declarator");
    if (!declaratorNode) return;

    const nameNode = getField(declaratorNode, "name");
    if (!nameNode) return;

    const fieldName = nameNode.text;
    const parentClassNode = getNearestAncestor(ancestors, (n) =>
      n.type === "class_declaration" ||
      n.type === "interface_declaration" ||
      n.type === "enum_declaration"
    );

    if (!parentClassNode) return;

    const parentNode = codeNodeBySyntaxNode.get(parentClassNode);
    if (!parentNode) return;

    const fqn = `${parentNode.id}.${fieldName}`;
    const range = toCodeRange(node);

    const fieldNode: CodeNode = {
      id: fqn,
      kind: "property",
      name: fieldName,
      qualifiedName: fqn,
      filePath: parsed.filePath,
      languageId: parsed.languageId,
      startLine: range.startLine,
      endLine: range.endLine,
    };

    nodes.push(fieldNode);

    edges.push({
      id: `edge:${parentNode.id}:contains:${fqn}:${range.startLine}`,
      source: parentNode.id,
      target: fqn,
      kind: "contains",
      filePath: parsed.filePath,
      line: range.startLine,
      confidence: "exact",
    });
  }

  function addMethodReference(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const nameNode = getField(node, "name");
    if (!nameNode) return;

    const methodName = nameNode.text;
    const containingMethod = getNearestAncestor(ancestors, (n) =>
      n.type === "method_declaration" ||
      n.type === "constructor_declaration"
    );

    const containerNode = containingMethod ? codeNodeBySyntaxNode.get(containingMethod) : fileNode;
    if (!containerNode) return;

    const range = toCodeRange(node);
    unresolvedReferences.push({
      fromNodeId: containerNode.id,
      referenceName: methodName,
      referenceKind: "calls",
      filePath: parsed.filePath,
      line: range.startLine,
      column: range.startColumn,
      languageId: parsed.languageId,
      calleeKind: "member",
    });
  }

  function addTypeReference(node: SyntaxNode, ancestors: readonly SyntaxNode[]): void {
    const typeName = node.text;

    // 跳过基本类型和关键字
    const primitives = new Set(["int", "long", "double", "float", "boolean", "char", "byte", "short", "void"]);
    if (primitives.has(typeName)) return;

    const containingMethod = getNearestAncestor(ancestors, (n) =>
      n.type === "method_declaration" ||
      n.type === "constructor_declaration" ||
      n.type === "field_declaration"
    );

    const containerNode = containingMethod ? codeNodeBySyntaxNode.get(containingMethod) : fileNode;
    if (!containerNode) return;

    const range = toCodeRange(node);
    unresolvedReferences.push({
      fromNodeId: containerNode.id,
      referenceName: typeName,
      referenceKind: "type_of",
      filePath: parsed.filePath,
      line: range.startLine,
      column: range.startColumn,
      languageId: parsed.languageId,
    });
  }
}
