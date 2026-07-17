import type { ReactAgentTool } from "./reactTypes";
import type { EditOperation, EditPreviewService } from "./editPreviewService";

export function createApplyEditTool(service: EditPreviewService): ReactAgentTool {
  console.log("createApplyEditTool called");
  return {
    name: "applyEdit",
    description: "Open VS Code's review UI for a complete workspace edit proposal; this tool handles user confirmation before applying.",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["replace"] },
                  path: { type: "string" },
                  oldText: { type: "string", minLength: 1 },
                  newText: { type: "string" },
                },
                required: ["kind", "path", "oldText", "newText"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["create"] },
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["kind", "path", "content"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["rename"] },
                  from: { type: "string" },
                  to: { type: "string" },
                },
                required: ["kind", "from", "to"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["delete"] },
                  path: { type: "string" },
                },
                required: ["kind", "path"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["changes"],
      additionalProperties: false,
    },
    async invoke({ input, signal }) {
      return service.apply(parseChanges(input), signal);
    },
  };
}

function parseChanges(input: unknown): EditOperation[] {
  if (!isRecord(input) || Object.keys(input).length !== 1 || !Array.isArray(input.changes) || input.changes.length === 0) {
    throw new Error("Invalid applyEdit input");
  }
  return input.changes.map(parseChange);
}

function parseChange(value: unknown): EditOperation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Invalid applyEdit operation");
  }
  if (value.kind === "replace" && hasOnlyStrings(value, ["kind", "path", "oldText", "newText"])) {
    return { kind: "replace", path: value.path, oldText: value.oldText, newText: value.newText };
  }
  if (value.kind === "create" && hasOnlyStrings(value, ["kind", "path", "content"])) {
    return { kind: "create", path: value.path, content: value.content };
  }
  if (value.kind === "rename" && hasOnlyStrings(value, ["kind", "from", "to"])) {
    return { kind: "rename", from: value.from, to: value.to };
  }
  if (value.kind === "delete" && hasOnlyStrings(value, ["kind", "path"])) {
    return { kind: "delete", path: value.path };
  }
  throw new Error("Invalid applyEdit operation");
}

function hasOnlyStrings(value: Record<string, unknown>, keys: readonly string[]): value is Record<string, string> {
  return Object.keys(value).length === keys.length && keys.every((key) => typeof value[key] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
