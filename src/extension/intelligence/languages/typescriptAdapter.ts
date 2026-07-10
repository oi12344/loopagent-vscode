import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";
import type { ExtractionResult, LanguageAdapter } from "./languageAdapter";
import { extractTypeScriptAst } from "./typescriptAstExtractor";

const CONTROL_FLOW_CALLS = new Set(["if", "for", "while", "switch", "function", "catch"]);

type ContainerScope = {
  kind: "class" | "function" | "method";
  nodeId: string;
  qualifiedName: string;
  exitDepth: number;
};

type PendingScope = Omit<ContainerScope, "exitDepth">;

export function createTypeScriptAdapter(): LanguageAdapter {
  return {
    id: "typescript",
    languageIds: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extract(parsed) {
      return parsed.tree ? extractTypeScriptAst(parsed) : extractTypeScriptFallback(parsed);
    },
  };
}

function extractTypeScriptFallback(parsed: ParsedSource): ExtractionResult {
  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const lines = parsed.text.split(/\r?\n/);
  const containerStack: ContainerScope[] = [];
  const pendingScopes: PendingScope[] = [];
  let braceDepth = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    activatePendingScopes(line, pendingScopes, containerStack, braceDepth);
    const currentClass = getCurrentClass(containerStack);
    let currentContainerId = getCurrentContainerId(containerStack, fileNode.id);
    const importMatch = line.match(/^\s*import\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["']/);
    if (importMatch) {
      for (const rawName of importMatch[1]!.split(",")) {
        const [importedName, aliasName] = rawName.trim().split(/\s+as\s+/i);
        if (!importedName) {
          continue;
        }
        importBindings.push({
          filePath: parsed.filePath,
          localName: (aliasName ?? importedName).trim(),
          importedName: importedName.trim(),
          source: importMatch[2]!,
          languageId: parsed.languageId,
        });
      }
    }

    const functionMatch = line.match(/^\s*(export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/);
    if (functionMatch) {
      const node = createSymbolNode(parsed, "function", functionMatch[2]!, lineNumber, Boolean(functionMatch[1]));
      nodes.push(node);
      edges.push(createEdge(fileNode.id, node.id, "contains", parsed.filePath, lineNumber));
      const scope = { kind: "function" as const, nodeId: node.id, qualifiedName: node.qualifiedName };
      if (hasFunctionBodyOpening(line)) {
        containerStack.push({ ...scope, exitDepth: getFunctionBodyExitDepth(line, braceDepth) });
      } else {
        pendingScopes.push(scope);
      }
      braceDepth = finishLine(line, containerStack, nodes, braceDepth, lineNumber);
      return;
    }

    const classMatch = line.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const node = createSymbolNode(parsed, "class", classMatch[2]!, lineNumber, Boolean(classMatch[1]));
      nodes.push(node);
      edges.push(createEdge(fileNode.id, node.id, "contains", parsed.filePath, lineNumber));
      const scope = { kind: "class" as const, nodeId: node.id, qualifiedName: node.qualifiedName };
      if (hasBlockOpeningAtEnd(line)) {
        containerStack.push({ ...scope, exitDepth: braceDepth + 1 });
      } else {
        pendingScopes.push(scope);
      }
      braceDepth = finishLine(line, containerStack, nodes, braceDepth, lineNumber);
      return;
    }

    const methodMatch = line.match(
      /^\s{2,}(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/,
    );
    if (methodMatch && currentClass) {
      const node = createSymbolNode(parsed, "method", methodMatch[1]!, lineNumber, false, {
        qualifiedName: `${currentClass.qualifiedName}.${methodMatch[1]!}`,
      });
      nodes.push(node);
      edges.push(createEdge(currentClass.nodeId, node.id, "contains", parsed.filePath, lineNumber));
      containerStack.push({ kind: "method", nodeId: node.id, qualifiedName: node.qualifiedName, exitDepth: braceDepth + 1 });
      currentContainerId = node.id;
    }

    for (const callMatch of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = callMatch[1]!;
      if (methodMatch && name === methodMatch[1]) {
        continue;
      }
      if (CONTROL_FLOW_CALLS.has(name)) {
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

    braceDepth = finishLine(line, containerStack, nodes, braceDepth, lineNumber);
  });

  closeRemainingScopes(containerStack, nodes, lines.length);
  return { nodes, edges, importBindings, unresolvedReferences, diagnostics: [] };
}

function getCurrentClass(containerStack: ContainerScope[]): ContainerScope | undefined {
  return [...containerStack].reverse().find((scope) => scope.kind === "class");
}

function getCurrentContainerId(containerStack: ContainerScope[], fileNodeId: string): string {
  return containerStack.at(-1)?.nodeId ?? fileNodeId;
}

function activatePendingScopes(
  line: string,
  pendingScopes: PendingScope[],
  containerStack: ContainerScope[],
  braceDepth: number,
): void {
  if (pendingScopes.length === 0) {
    return;
  }

  while (pendingScopes.length > 0 && shouldActivatePendingScope(pendingScopes[0]!, line)) {
    const scope = pendingScopes.shift()!;
    containerStack.push({ ...scope, exitDepth: getPendingScopeExitDepth(scope, line, braceDepth) });
  }
}

function shouldActivatePendingScope(scope: PendingScope, line: string): boolean {
  if (scope.kind === "function" || scope.kind === "method") {
    return hasFunctionBodyOpening(line);
  }
  return hasBlockOpeningAtEnd(line);
}

function getPendingScopeExitDepth(scope: PendingScope, line: string, braceDepth: number): number {
  if (scope.kind === "function" || scope.kind === "method") {
    return getFunctionBodyExitDepth(line, braceDepth);
  }
  return braceDepth + 1;
}

function finishLine(
  line: string,
  containerStack: ContainerScope[],
  nodes: CodeNode[],
  currentDepth: number,
  lineNumber: number,
): number {
  const nextDepth = currentDepth + countBraceDelta(line);
  if (!line.includes("}")) {
    return nextDepth;
  }

  while (containerStack.length > 0 && nextDepth < containerStack[containerStack.length - 1]!.exitDepth) {
    const scope = containerStack.pop()!;
    setNodeEndLine(nodes, scope.nodeId, lineNumber);
  }
  return nextDepth;
}

function closeRemainingScopes(containerStack: ContainerScope[], nodes: CodeNode[], endLine: number): void {
  while (containerStack.length > 0) {
    const scope = containerStack.pop()!;
    setNodeEndLine(nodes, scope.nodeId, endLine);
  }
}

function hasFunctionBodyOpening(line: string): boolean {
  const closingParenIndex = line.lastIndexOf(")");
  if (closingParenIndex < 0) {
    return false;
  }
  return line.indexOf("{", closingParenIndex) >= 0;
}

function getFunctionBodyExitDepth(line: string, currentDepth: number): number {
  const closingParenIndex = line.lastIndexOf(")");
  const bodyOpenIndex = closingParenIndex >= 0 ? line.indexOf("{", closingParenIndex) : line.indexOf("{");
  if (bodyOpenIndex < 0) {
    return currentDepth + 1;
  }
  return currentDepth + countBraceDelta(line.slice(0, bodyOpenIndex)) + 1;
}

function hasBlockOpeningAtEnd(line: string): boolean {
  return /\{\s*(?:\/\/.*)?$/.test(line);
}

function setNodeEndLine(nodes: CodeNode[], nodeId: string, endLine: number): void {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node) {
    node.endLine = Math.max(node.startLine, endLine);
  }
}

function countBraceDelta(line: string): number {
  return [...line].reduce((delta, char) => {
    if (char === "{") {
      return delta + 1;
    }
    if (char === "}") {
      return delta - 1;
    }
    return delta;
  }, 0);
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
  kind: CodeNode["kind"],
  name: string,
  line: number,
  isExported: boolean,
  options: { qualifiedName?: string } = {},
): CodeNode {
  return {
    id: `symbol:${parsed.filePath}:${kind}:${name}:${line}`,
    kind,
    name,
    qualifiedName: options.qualifiedName ?? `${parsed.filePath}::${name}`,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: line,
    endLine: line,
    isExported,
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
