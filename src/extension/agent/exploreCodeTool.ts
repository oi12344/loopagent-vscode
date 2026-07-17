import type { WorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import type { ReactAgentTool } from "./reactTypes";

export const MAX_EXPLORE_CODE_QUERY_LENGTH = 1_000;
const EMPTY_OBSERVATION = "未命中代码上下文。";
const FAILED_OBSERVATION = "代码搜索失败，请调整查询后重试。";

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
    async invoke({ input, signal }) {
      const query = parseQuery(input);
      signal.throwIfAborted();

      let prompt: string;
      try {
        prompt = await workspaceIntelligence.buildCodeIntelligencePrompt(query);
      } catch {
        signal.throwIfAborted();
        return FAILED_OBSERVATION;
      }

      signal.throwIfAborted();
      return prompt.length > 0 ? prompt : EMPTY_OBSERVATION;
    },
  };
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
