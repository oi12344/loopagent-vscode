import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";
import type { ExtractionResult, LanguageAdapter } from "./languageAdapter";

const CONTROL_FLOW_CALLS = new Set(["if", "for", "while", "switch", "function", "catch"]);

type ContainerScope = {
  kind: "class" | "function" | "method";
  nodeId: string;
  exitDepth: number;
};

export function createTypeScriptAdapter(): LanguageAdapter {
  return {
    id: "typescript",
    languageIds: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extract(parsed) {
      return extractTypeScriptLike(parsed);
    },
  };
}

function extractTypeScriptLike(parsed: ParsedSource): ExtractionResult {
  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const lines = parsed.text.split(/\r?\n/);
  const containerStack: ContainerScope[] = [];
  let braceDepth = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const currentClassId = getCurrentClassId(containerStack);
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

    const functionMatch = line.match(/^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (functionMatch) {
      const node = createSymbolNode(parsed, "function", functionMatch[2]!, lineNumber, Boolean(functionMatch[1]));
      nodes.push(node);
      edges.push(createEdge(fileNode.id, node.id, "contains", parsed.filePath, lineNumber));
      containerStack.push({ kind: "function", nodeId: node.id, exitDepth: braceDepth + 1 });
      braceDepth = finishLine(line, containerStack, braceDepth);
      return;
    }

    const classMatch = line.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const node = createSymbolNode(parsed, "class", classMatch[2]!, lineNumber, Boolean(classMatch[1]));
      nodes.push(node);
      edges.push(createEdge(fileNode.id, node.id, "contains", parsed.filePath, lineNumber));
      containerStack.push({ kind: "class", nodeId: node.id, exitDepth: braceDepth + 1 });
      braceDepth = finishLine(line, containerStack, braceDepth);
      return;
    }

    const methodMatch = line.match(
      /^\s{2,}(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/,
    );
    if (methodMatch && currentClassId) {
      const node = createSymbolNode(parsed, "method", methodMatch[1]!, lineNumber, false);
      nodes.push(node);
      edges.push(createEdge(currentClassId, node.id, "contains", parsed.filePath, lineNumber));
      containerStack.push({ kind: "method", nodeId: node.id, exitDepth: braceDepth + 1 });
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

    braceDepth = finishLine(line, containerStack, braceDepth);
  });

  return { nodes, edges, importBindings, unresolvedReferences, diagnostics: [...parsed.diagnostics] };
}

function getCurrentClassId(containerStack: ContainerScope[]): string | undefined {
  return [...containerStack].reverse().find((scope) => scope.kind === "class")?.nodeId;
}

function getCurrentContainerId(containerStack: ContainerScope[], fileNodeId: string): string {
  return containerStack.at(-1)?.nodeId ?? fileNodeId;
}

function finishLine(line: string, containerStack: ContainerScope[], currentDepth: number): number {
  const nextDepth = currentDepth + countBraceDelta(line);
  if (!line.includes("}")) {
    return nextDepth;
  }

  while (containerStack.length > 0 && nextDepth < containerStack[containerStack.length - 1]!.exitDepth) {
    containerStack.pop();
  }
  return nextDepth;
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
): CodeNode {
  return {
    id: `symbol:${parsed.filePath}:${kind}:${name}:${line}`,
    kind,
    name,
    qualifiedName: `${parsed.filePath}::${name}`,
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
