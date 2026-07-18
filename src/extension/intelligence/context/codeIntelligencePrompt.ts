import type { CodeIntelligenceResult } from "./codeIntelligenceContext";
import type { SearchNodeResult, StoredCodeChunk } from "../storage/sqliteIndexStore";

export function renderCodeIntelligencePrompt(result: CodeIntelligenceResult): string {
  if (result.entryNodes.length === 0 && result.snippets.length === 0) {
    return "";
  }

  const lines: string[] = ["## 代码语义索引上下文", "", `查询: ${result.query}`, "", "### 入口符号"];

  for (const node of result.entryNodes) {
    lines.push(`- ${node.kind} ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`);
  }

  if (result.relatedNodes.length > 0) {
    lines.push("", "### 相关符号");
    for (const node of result.relatedNodes) {
      lines.push(`- ${node.kind} ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`);
    }
  }

  if (result.edges.length > 0) {
    lines.push("", "### 关系");
    for (const edge of result.edges) {
      lines.push(
        `- ${edge.source} --${edge.kind}/${edge.confidence}--> ${edge.target}${
          edge.line ? ` @${edge.filePath}:${edge.line}` : ""
        }`,
      );
    }
  }

  if (result.snippets.length > 0) {
    lines.push("", "### 源码片段");
    for (const snippet of result.snippets) {
      lines.push(`#### ${snippet.filePath}:${snippet.startLine}-${snippet.endLine}`);
      lines.push(`\`\`\`${languageFromPath(snippet.filePath)}`);
      lines.push(snippet.text.replace(/```/g, "``\\`"));
      lines.push("```");
    }
  }

  lines.push("", "### 语义索引预算");
  lines.push(`- 上下文模式: ${result.profile.mode} (${result.profile.reason})`);
  lines.push(`- 源码片段: ${result.snippets.length}/${result.profile.maxSnippetNodes}`);
  lines.push(`- 使用字符: ${result.budget.usedChars}/${result.budget.maxChars}`);
  lines.push(`- 是否截断: ${result.budget.truncated ? "是" : "否"}`);

  return lines.join("\n").trim();
}

export function renderPersistedCodeIntelligencePrompt(
  query: string,
  nodes: readonly SearchNodeResult[],
  chunks: readonly StoredCodeChunk[],
): string {
  if (nodes.length === 0 && chunks.length === 0) return "";
  const lines: string[] = ["## 代码语义索引上下文", "", `查询: ${query}`];

  if (nodes.length > 0) {
    lines.push("", "### 精确符号匹配");
    for (const node of nodes) {
      lines.push(`- ${node.kind} ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`);
    }
  }

  if (chunks.length > 0) {
    lines.push("", "### 源码片段");
    let remainingChars = 6_000;
    for (const chunk of chunks) {
      if (remainingChars <= 0) break;
      const range = chunk.startLine ? `:${chunk.startLine}-${chunk.endLine ?? chunk.startLine}` : "";
      lines.push(`#### ${chunk.filePath}${range}`);
      lines.push(`\`\`\`${languageFromPath(chunk.filePath)}`);
      const text = chunk.sourceText.replace(/```/g, "``\\`").slice(0, remainingChars);
      remainingChars -= text.length;
      lines.push(text);
      lines.push("```");
    }
  }

  lines.push("", "### 语义索引预算", "- 来源: SQLite FTS", `- 符号匹配: ${nodes.length}/12`, `- 源码片段: ${chunks.length}/6`);
  return lines.join("\n").trim();
}

function languageFromPath(filePath: string): string {
  if (filePath.endsWith(".py")) {
    return "python";
  }
  if (filePath.endsWith(".tsx") || filePath.endsWith(".ts")) {
    return "typescript";
  }
  if (filePath.endsWith(".jsx") || filePath.endsWith(".js")) {
    return "javascript";
  }
  return "text";
}
