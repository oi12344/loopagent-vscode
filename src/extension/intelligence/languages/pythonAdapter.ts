import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";
import type { ExtractionResult, LanguageAdapter } from "./languageAdapter";
import { extractPythonAst } from "./pythonAstExtractor";

const KEYWORD_CALLS = new Set([
  "and",
  "assert",
  "async",
  "await",
  "class",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "not",
  "or",
  "raise",
  "return",
  "try",
  "while",
  "with",
]);

type IndexedContainerScope = {
  kind: "class" | "function" | "method";
  node: CodeNode;
  indent: number;
};

type LocalFunctionScope = {
  kind: "local_function";
  indent: number;
};

type ContainerScope = IndexedContainerScope | LocalFunctionScope;

export function createPythonAdapter(): LanguageAdapter {
  return {
    id: "python",
    languageIds: ["python"],
    extensions: [".py"],
    extract(parsed) {
      return parsed.tree ? extractPythonAst(parsed) : extractPythonFallback(parsed);
    },
  };
}

function extractPythonFallback(parsed: ParsedSource): ExtractionResult {
  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const lines = parsed.text.split(/\r?\n/);
  const containerStack: ContainerScope[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmedLine = line.trim();
    const indent = countIndent(line);

    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      return;
    }

    unwindScopes(containerStack, indent, lineNumber - 1);

    const importMatch = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/);
    if (importMatch) {
      for (const binding of parseFromImportBindings(parsed, importMatch[1]!, importMatch[2]!)) {
        importBindings.push(binding);
      }
    }

    const classMatch = line.match(/^class\s+([A-Za-z_]\w*)\b.*:\s*(?:#.*)?$/);
    if (classMatch) {
      const node = createSymbolNode(parsed, "class", classMatch[1]!, lineNumber);
      nodes.push(node);
      edges.push(createEdge(fileNode.id, node.id, "contains", parsed.filePath, lineNumber));
      containerStack.push({ kind: "class", node, indent });
      return;
    }

    const functionMatch = line.match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      const name = functionMatch[2]!;
      const currentScope = getCurrentScope(containerStack);
      if (currentScope?.kind === "class" && indent > currentScope.indent) {
        const node = createSymbolNode(parsed, "method", name, lineNumber);
        nodes.push(node);
        edges.push(createEdge(currentScope.node.id, node.id, "contains", parsed.filePath, lineNumber));
        containerStack.push({ kind: "method", node, indent });
        return;
      }

      if (indent === 0) {
        const node = createSymbolNode(parsed, "function", name, lineNumber);
        nodes.push(node);
        edges.push(createEdge(fileNode.id, node.id, "contains", parsed.filePath, lineNumber));
        containerStack.push({ kind: "function", node, indent });
      }
      if (indent > 0) {
        containerStack.push({ kind: "local_function", indent });
      }
      return;
    }

    const currentContainerId = getCurrentContainerId(containerStack);
    if (!currentContainerId) {
      return;
    }

    for (const callMatch of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const name = callMatch[1]!;
      if (KEYWORD_CALLS.has(name)) {
        continue;
      }
      unresolvedReferences.push({
        fromNodeId: currentContainerId,
        referenceName: name,
        referenceKind: "calls",
        filePath: parsed.filePath,
        line: lineNumber,
        column: callMatch.index,
        languageId: parsed.languageId,
      });
    }
  });

  unwindScopes(containerStack, -1, lines.length);

  return { nodes, edges, importBindings, unresolvedReferences, diagnostics: [] };
}

function parseFromImportBindings(parsed: ParsedSource, source: string, importList: string): ImportBinding[] {
  return importList
    .split(",")
    .map((rawName) => rawName.trim())
    .filter(Boolean)
    .map((rawName) => {
      const [importedName, aliasName] = rawName.split(/\s+as\s+/i).map((part) => part.trim());
      const localName = aliasName || importedName;
      return {
        filePath: parsed.filePath,
        localName,
        importedName,
        source,
        languageId: parsed.languageId,
      };
    });
}

function unwindScopes(containerStack: ContainerScope[], indent: number, endLine: number): void {
  while (containerStack.length > 0 && indent <= containerStack[containerStack.length - 1]!.indent) {
    const scope = containerStack.pop()!;
    if (scope.kind !== "local_function") scope.node.endLine = endLine;
  }
}

function getCurrentScope(containerStack: ContainerScope[]): ContainerScope | undefined {
  return containerStack.at(-1);
}

function getCurrentContainerId(containerStack: ContainerScope[]): string | undefined {
  if (containerStack.at(-1)?.kind === "local_function") {
    return undefined;
  }
  const scope = [...containerStack].reverse().find(isCallableScope);
  return scope?.node.id;
}

function isCallableScope(scope: ContainerScope): scope is IndexedContainerScope {
  return scope.kind === "function" || scope.kind === "method";
}

function countIndent(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === " ") {
      indent += 1;
      continue;
    }
    if (char === "\t") {
      indent += 4;
      continue;
    }
    break;
  }
  return indent;
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

function createSymbolNode(parsed: ParsedSource, kind: CodeNode["kind"], name: string, line: number): CodeNode {
  return {
    id: `symbol:${parsed.filePath}:${kind}:${name}:${line}`,
    kind,
    name,
    qualifiedName: `${parsed.filePath}::${name}`,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: line,
    endLine: line,
    isExported: false,
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
