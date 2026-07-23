import { createHash } from "node:crypto";

import type * as vscode from "vscode";
import type { WorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import type { MemoryEvidence } from "../memory/types";
import type { ReactAgentTool, ReactAgentToolResult } from "./reactTypes";

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel | undefined {
  if (!outputChannel) {
    try {
      const vsc = require("vscode") as typeof vscode;
      outputChannel = vsc.window.createOutputChannel("LoopAgent Debug");
    } catch {
      // Fallback if vscode not available
    }
  }
  return outputChannel;
}

export const MAX_EXPLORE_CODE_QUERY_LENGTH = 1_000;
const EMPTY_OBSERVATION = "未命中代码上下文。";
const FAILED_OBSERVATION = "代码搜索失败，请调整查询后重试。";
const MAX_EVIDENCE_SNIPPETS = 4;

export function createExploreCodeTool(workspaceIntelligence: WorkspaceIntelligence): ReactAgentTool {
  return {
    name: "exploreCode",
    description: "Search the current workspace for code relevant to a repository implementation question.",
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concise code-oriented search query using likely symbols or implementation terms.",
          maxLength: MAX_EXPLORE_CODE_QUERY_LENGTH,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async invoke({ input, signal }): Promise<ReactAgentToolResult> {
      const query = parseQuery(input);
      signal.throwIfAborted();
      getOutputChannel()?.appendLine(`[exploreCode] 工具调用开始 query="${query}"`);

      let content: string;
      let evidence: MemoryEvidence[] = [];
      try {
        if (workspaceIntelligence.buildCodeIntelligenceResult) {
          const result = await workspaceIntelligence.buildCodeIntelligenceResult(query);
          content = result.prompt.length > 0 ? result.prompt : EMPTY_OBSERVATION;
          evidence = buildSnippetEvidence(result.snippets);
        } else {
          const prompt = await workspaceIntelligence.buildCodeIntelligencePrompt(query);
          content = prompt.length > 0 ? prompt : EMPTY_OBSERVATION;
        }
      } catch (error) {
        signal.throwIfAborted();
        getOutputChannel()?.appendLine(
          `[exploreCode] buildCodeIntelligencePrompt 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { content: FAILED_OBSERVATION, evidence: [] };
      }

      signal.throwIfAborted();
      const format = content.startsWith("##") ? "Markdown" : content.startsWith("<") ? "XML/DSML" : "文本";
      getOutputChannel()?.appendLine(
        `[exploreCode] 工具返回 长度=${content.length} 格式=${format} 前100字符="${content.slice(0, 100)}"`,
      );
      return { content, evidence };
    },
  };
}

function buildSnippetEvidence(
  snippets: readonly { filePath: string; startLine: number; endLine: number; text: string }[],
): MemoryEvidence[] {
  return snippets.slice(0, MAX_EVIDENCE_SNIPPETS).map((snippet) => ({
    filePath: snippet.filePath,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    sha256: createHash("sha256").update(snippet.text).digest("hex"),
    required: true,
  }));
}

function parseQuery(input: unknown): string {
  if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.query !== "string") {
    throw new Error("Invalid exploreCode input: expected only a string query");
  }

  if (input.query.length > MAX_EXPLORE_CODE_QUERY_LENGTH) {
    throw new Error(`Invalid exploreCode input: query exceeds ${MAX_EXPLORE_CODE_QUERY_LENGTH} characters`);
  }

  const query = input.query.trim();
  if (query.length === 0) {
    throw new Error("Invalid exploreCode input: query must not be blank");
  }

  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
