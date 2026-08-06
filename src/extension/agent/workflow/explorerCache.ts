import type { ProjectMemory } from "../../memory/projectMemory";
import type { HostToWebviewMessage } from "../../../shared/messages";

/**
 * 探索结果缓存
 * 从 explorer 子代理的输出中提取发现的文件、符号等信息，保存到 projectMemory
 */

export type ExplorerFindings = {
  files: string[];
  symbols: string[];
  insights: string[];
};

/**
 * 从子代理消息中提取探索发现
 */
export function extractExplorerFindings(
  messages: readonly HostToWebviewMessage[],
  content?: string,
): ExplorerFindings {
  const files = new Set<string>();
  const symbols = new Set<string>();
  const insights: string[] = [];

  // 从工具调用中提取文件路径
  for (const message of messages) {
    if (message.type === "toolCallStarted") {
      if (message.toolName === "readFile" || message.toolName === "exploreCode") {
        const pathMatch = message.input.match(/['"]([^'"]+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h))['"]/);
        if (pathMatch) {
          files.add(pathMatch[1]);
        }
      }

      if (message.toolName === "browseSymbols") {
        const symbolMatch = message.input.match(/['"]([^'"]+)['"]/);
        if (symbolMatch) {
          symbols.add(symbolMatch[1]);
        }
      }
    }

    // 从 agent 输出中提取关键见解
    if (message.type === "agentEvent") {
      const msg = message.message;
      if (
        msg.includes("found") ||
        msg.includes("located") ||
        msg.includes("defined in") ||
        msg.includes("implemented")
      ) {
        insights.push(msg);
      }
    }
  }

  // 从最终内容中提取文件路径（markdown 代码块、路径引用）
  if (content) {
    const filePathPattern = /(?:^|\s)([a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h))(?:\s|$|:|\))/g;
    let match;
    while ((match = filePathPattern.exec(content)) !== null) {
      files.add(match[1]);
    }

    // 提取符号引用（函数名、类名等）
    const symbolPattern = /(?:function|class|interface|type|const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((match = symbolPattern.exec(content)) !== null) {
      symbols.add(match[1]);
    }
  }

  return {
    files: [...files],
    symbols: [...symbols],
    insights: insights.slice(0, 5), // 限制最多5条关键见解
  };
}

/**
 * 将探索结果保存到项目记忆
 */
export async function cacheExplorerFindings(
  projectMemory: ProjectMemory,
  task: string,
  findings: ExplorerFindings,
  generation: number,
): Promise<void> {
  if (findings.files.length === 0 && findings.symbols.length === 0) {
    // 没有有价值的发现，不保存
    return;
  }

  // 构造摘要
  const summary = buildFindingsSummary(task, findings);

  // 保存到 projectMemory
  await projectMemory.recordOutcome(
    {
      runId: `explorer-${Date.now()}`,
      task,
      status: "completed",
      finalContent: summary,
      evidence: [],
    },
    generation,
  );
}

function buildFindingsSummary(task: string, findings: ExplorerFindings): string {
  const parts: string[] = [];

  parts.push(`Exploration task: ${task}`);
  parts.push("");

  if (findings.files.length > 0) {
    parts.push("Relevant files:");
    findings.files.slice(0, 10).forEach((file) => parts.push(`- ${file}`));
    if (findings.files.length > 10) {
      parts.push(`... and ${findings.files.length - 10} more`);
    }
    parts.push("");
  }

  if (findings.symbols.length > 0) {
    parts.push("Key symbols:");
    findings.symbols.slice(0, 10).forEach((symbol) => parts.push(`- ${symbol}`));
    if (findings.symbols.length > 10) {
      parts.push(`... and ${findings.symbols.length - 10} more`);
    }
    parts.push("");
  }

  if (findings.insights.length > 0) {
    parts.push("Key insights:");
    findings.insights.forEach((insight) => parts.push(`- ${insight}`));
  }

  return parts.join("\n");
}
