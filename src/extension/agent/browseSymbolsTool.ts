import type { WorkspaceIntelligence, SymbolRef } from "../intelligence/workspaceIntelligence";
import type { ReactAgentTool, ReactAgentToolResult } from "./reactTypes";

export const MAX_BROWSE_SYMBOLS_QUERY_LENGTH = 200;
const EMPTY_OBSERVATION = "未找到匹配的符号。";
const FAILED_OBSERVATION = "符号浏览失败，请调整查询后重试。";

export function createBrowseSymbolsTool(workspaceIntelligence: WorkspaceIntelligence): ReactAgentTool | undefined {
  if (!workspaceIntelligence.browseSymbols) return undefined;

  return {
    name: "browseSymbols",
    description:
      "List symbol names (functions, classes, interfaces, constants) in the workspace that match a concept or " +
      "partial name. Returns names and file locations only — no code content. " +
      "Call this BEFORE exploreCode when you are uncertain what symbols exist. " +
      "Use the exact names you discover here as your query in exploreCode for precise results.",
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concept or partial symbol name to search for, e.g. 'intent route classify'.",
          maxLength: MAX_BROWSE_SYMBOLS_QUERY_LENGTH,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async invoke({ input, signal }): Promise<ReactAgentToolResult> {
      const query = parseQuery(input);
      signal.throwIfAborted();

      try {
        const symbols = await workspaceIntelligence.browseSymbols!(query);
        signal.throwIfAborted();

        if (symbols.length === 0) {
          return { content: EMPTY_OBSERVATION, evidence: [], productive: false };
        }

        return { content: formatSymbols(symbols), evidence: [], productive: true };
      } catch (error) {
        signal.throwIfAborted();
        return { content: FAILED_OBSERVATION, evidence: [], productive: false };
      }
    },
  };
}

function formatSymbols(symbols: SymbolRef[]): string {
  const lines = [`browseSymbols result (${symbols.length} matches):\n`];
  for (const sym of symbols) {
    const kind = sym.kind.toUpperCase().padEnd(14);
    const name = sym.name.padEnd(42);
    const loc = `${sym.filePath}:${sym.startLine}`;
    lines.push(`${kind}${name}${loc}`);
  }
  return lines.join("\n");
}

function parseQuery(input: unknown): string {
  if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.query !== "string") {
    throw new Error("Invalid browseSymbols input: expected only a string query");
  }
  if (input.query.length > MAX_BROWSE_SYMBOLS_QUERY_LENGTH) {
    throw new Error(`Invalid browseSymbols input: query exceeds ${MAX_BROWSE_SYMBOLS_QUERY_LENGTH} characters`);
  }
  const query = input.query.trim();
  if (query.length === 0) {
    throw new Error("Invalid browseSymbols input: query must not be blank");
  }
  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
