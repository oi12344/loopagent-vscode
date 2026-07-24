import type { ReactAgentTool } from "./reactTypes";
import type { WorkflowOrchestrator } from "./workflowOrchestrator";
import type { CreateSubagentConfig, SubagentResult } from "./workflow/types";

type WorkflowToolsOptions = {
  orchestrator: WorkflowOrchestrator;
  availableTools: readonly ReactAgentTool[];
};

export function createWorkflowTools({ orchestrator, availableTools }: WorkflowToolsOptions): ReactAgentTool[] {
  return [
    {
      name: "spawnSubagent",
      description: "Create a subagent to complete a task.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", minLength: 1 },
          dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
          toolHints: { type: "array", items: { type: "string", minLength: 1 } },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        required: ["task"],
      },
      isConcurrencySafe: () => true,
      invoke({ input }) {
        const config = parseCreateSubagentInput(input);
        return JSON.stringify({ subagentId: orchestrator.createSubagent(config, availableTools) });
      },
    },
    {
      name: "waitForSubagents",
      description: "Wait for subagents to finish and return their results.",
      inputSchema: {
        type: "object",
        properties: { subagentIds: { type: "array", items: { type: "string", minLength: 1 } } },
        required: ["subagentIds"],
      },
      isConcurrencySafe: () => true,
      async invoke({ input }) {
        const subagentIds = parseStringArray(input, "subagentIds");
        const results = await orchestrator.waitForSubagents(subagentIds);
        return JSON.stringify({ results: Object.fromEntries(results) as Record<string, SubagentResult> });
      },
    },
    {
      name: "cancelSubagent",
      description: "Cancel a subagent.",
      inputSchema: {
        type: "object",
        properties: { subagentId: { type: "string", minLength: 1 } },
        required: ["subagentId"],
      },
      isConcurrencySafe: () => true,
      invoke({ input }) {
        const subagentId = parseStringProperty(input, "subagentId");
        if (!orchestrator.cancelSubagent(subagentId)) {
          throw new Error(`Subagent ${subagentId} was not found or is already finished`);
        }
        return JSON.stringify({ subagentId, cancelled: true });
      },
    },
  ];
}

function parseCreateSubagentInput(input: unknown): CreateSubagentConfig {
  const record = requireRecord(input);
  const task = requireString(record.task, "task");
  const dependsOn = record.dependsOn === undefined ? undefined : requireStringArray(record.dependsOn, "dependsOn");
  const toolHints = record.toolHints === undefined ? undefined : requireStringArray(record.toolHints, "toolHints");
  const timeoutMs = record.timeoutMs === undefined ? undefined : requireTimeout(record.timeoutMs);
  return { task, ...(dependsOn && { dependsOn }), ...(toolHints && { toolHints }), ...(timeoutMs && { timeoutMs }) };
}

function parseStringArray(input: unknown, property: string): string[] {
  return requireStringArray(requireRecord(input)[property], property);
}

function parseStringProperty(input: unknown, property: string): string {
  return requireString(requireRecord(input)[property], property);
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, property: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${property} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, property: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${property} entries must be non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function requireTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  return value;
}
