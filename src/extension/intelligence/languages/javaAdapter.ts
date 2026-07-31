import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";
import type { ExtractionResult, LanguageAdapter } from "./languageAdapter";
import { extractJavaAst } from "./javaAstExtractor";

/**
 * Java 语言适配器
 *
 * 优先使用 Tree-sitter 进行完整的 AST 解析。
 * 如果 Tree-sitter 不可用，降级到正则表达式提取。
 */
export function createJavaAdapter(): LanguageAdapter {
  return {
    id: "java",
    languageIds: ["java"],
    extensions: [".java"],
    extract(parsed: ParsedSource): ExtractionResult {
      return parsed.tree ? extractJavaAst(parsed) : extractJavaFallback(parsed);
    },
  };
}

function createFileNode(parsed: ParsedSource): CodeNode {
  return {
    id: `file://${parsed.filePath}`,
    kind: "module",
    name: parsed.filePath.split(/[/\\]/).pop() ?? parsed.filePath,
    filePath: parsed.filePath,
    line: 1,
  };
}

/**
 * 降级实现：当 Tree-sitter 不可用时使用正则表达式
 */
function extractJavaFallback(parsed: ParsedSource): ExtractionResult {
  const fileNode = createFileNode(parsed);
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const lines = parsed.text.split(/\r?\n/);

  // 简单的正则匹配来提取类、接口、方法等
  const classPattern = /^\s*(?:public|private|protected)?\s*(?:static|final|abstract)?\s*(?:class|interface|enum)\s+(\w+)/;
  const methodPattern = /^\s*(?:public|private|protected)?\s*(?:static|final|abstract|synchronized)?\s*(?:<[^>]+>\s*)?(?:[\w<>\[\]]+)\s+(\w+)\s*\(/;
  const fieldPattern = /^\s*(?:public|private|protected)?\s*(?:static|final)?\s*[\w<>\[\]]+\s+(\w+)\s*[=;]/;
  const importPattern = /^\s*import\s+([\w.]+);/;

  let currentClass = "";
  let packageName = "";
  let currentClassNodeId = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // 提取包名
    const packageMatch = line.match(/^\s*package\s+([\w.]+);/);
    if (packageMatch) {
      packageName = packageMatch[1];
      continue;
    }

    // 提取 import
    const importMatch = line.match(importPattern);
    if (importMatch) {
      const importPath = importMatch[1];
      const importedName = importPath.split(".").pop() ?? importPath;
      importBindings.push({
        localName: importedName,
        importedName,
        modulePath: importPath,
        filePath: parsed.filePath,
        line: lineNumber,
      });
      continue;
    }

    // 提取类/接口/枚举
    const classMatch = line.match(classPattern);
    if (classMatch) {
      const className = classMatch[1];
      currentClass = className;
      const fqn = packageName ? `${packageName}.${className}` : className;
      currentClassNodeId = fqn;

      nodes.push({
        id: fqn,
        kind: "class",
        name: className,
        filePath: parsed.filePath,
        line: lineNumber,
      });

      edges.push({
        from: fileNode.id,
        to: fqn,
        kind: "contains",
      });
      continue;
    }

    // 提取方法
    const methodMatch = line.match(methodPattern);
    if (methodMatch && currentClass) {
      const methodName = methodMatch[1];
      const fqn = packageName
        ? `${packageName}.${currentClass}.${methodName}`
        : `${currentClass}.${methodName}`;

      nodes.push({
        id: fqn,
        kind: "function",
        name: methodName,
        filePath: parsed.filePath,
        line: lineNumber,
      });

      if (currentClassNodeId) {
        edges.push({
          from: currentClassNodeId,
          to: fqn,
          kind: "contains",
        });
      }
    }

    // 提取字段（简单版本）
    const fieldMatch = line.match(fieldPattern);
    if (fieldMatch && currentClass && !line.includes("(")) {
      const fieldName = fieldMatch[1];
      const fqn = packageName
        ? `${packageName}.${currentClass}.${fieldName}`
        : `${currentClass}.${fieldName}`;

      nodes.push({
        id: fqn,
        kind: "property",
        name: fieldName,
        filePath: parsed.filePath,
        line: lineNumber,
      });

      if (currentClassNodeId) {
        edges.push({
          from: currentClassNodeId,
          to: fqn,
          kind: "contains",
        });
      }
    }
  }

  return {
    nodes,
    edges,
    importBindings,
    unresolvedReferences,
    diagnostics: [],
  };
}
