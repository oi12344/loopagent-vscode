import { isIndexableWorkspacePath } from "../intelligence/indexing/workspaceFilePolicy";
import type { ReactAgentTool } from "./reactTypes";
import { readWorkspaceText, resolveWorkspaceFileUri, type VsCodeEditApi } from "./editPreviewService";

const MAX_READ_FILE_LENGTH = 20_000;
const TRUNCATION_NOTICE = "Read file was truncated at 20000 characters; request a line range.";

export function createReadFileTool(vscodeApi: VsCodeEditApi): ReactAgentTool {
  return {
    name: "readFile",
    description: "Read a text file in the current workspace before proposing an edit.",
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async invoke({ input, signal }) {
      const { path, startLine, endLine } = parseReadInput(input);
      if (!isIndexableWorkspacePath(path)) {
        throw new Error("Invalid readFile path");
      }
      signal.throwIfAborted();
      const uri = await resolveWorkspaceFileUri(vscodeApi, path);
      const content = await readWorkspaceText(vscodeApi, uri);
      signal.throwIfAborted();
      const selected = startLine === undefined ? content : content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
      return selected.length > MAX_READ_FILE_LENGTH
        ? `${selected.slice(0, MAX_READ_FILE_LENGTH)}\n\n${TRUNCATION_NOTICE}`
        : selected;
    },
  };
}

function parseReadInput(input: unknown): { path: string; startLine?: number; endLine?: number } {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("Invalid readFile input");
  }
  const keys = Object.keys(input);
  if (!keys.every((key) => key === "path" || key === "startLine" || key === "endLine")) {
    throw new Error("Invalid readFile input");
  }
  const hasStart = input.startLine !== undefined;
  const hasEnd = input.endLine !== undefined;
  if (hasStart !== hasEnd) {
    throw new Error("Invalid readFile input");
  }
  if (!hasStart) {
    return { path: input.path };
  }
  if (!isPositiveInteger(input.startLine) || !isPositiveInteger(input.endLine) || input.startLine > input.endLine) {
    throw new Error("Invalid readFile input");
  }
  return { path: input.path, startLine: input.startLine, endLine: input.endLine };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
