import { describe, expect, it, vi } from "vitest";

import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { WorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";
import { createWorkflowTools } from "../src/extension/agent/workflowTools";

describe("workflow tools", () => {
  it("creates a subagent and returns its id", async () => {
    const createSubagent = vi.fn(() => "subagent-1");
    const tools = createWorkflowTools({ orchestrator: fakeOrchestrator({ createSubagent }), availableTools });

    await expect(invoke(tools, "spawnSubagent", { task: "Read the project", dependsOn: ["subagent-0"], toolHints: ["readFile"], timeoutMs: 5000 })).resolves.toBe(
      JSON.stringify({ subagentId: "subagent-1" }),
    );
    expect(createSubagent).toHaveBeenCalledWith(
      { task: "Read the project", dependsOn: ["subagent-0"], toolHints: ["readFile"], timeoutMs: 5000 },
      availableTools,
    );
    expect((toolByName(tools, "spawnSubagent").inputSchema.properties as Record<string, unknown>).timeoutMs).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(toolByName(tools, "spawnSubagent").isConcurrencySafe?.({ task: "Read the project" })).toBe(true);
  });

  it("waits for requested subagents and serializes their results", async () => {
    const waitForSubagents = vi.fn(async () => new Map([["subagent-1", { status: "completed" as const, content: "done" }]]));
    const tools = createWorkflowTools({ orchestrator: fakeOrchestrator({ waitForSubagents }), availableTools });

    await expect(invoke(tools, "waitForSubagents", { subagentIds: ["subagent-1"] })).resolves.toBe(
      JSON.stringify({ results: { "subagent-1": { status: "completed", content: "done" } } }),
    );
    expect(waitForSubagents).toHaveBeenCalledWith(["subagent-1"]);
  });

  it("cancels a subagent and confirms the cancellation", async () => {
    const cancelSubagent = vi.fn(() => true);
    const tools = createWorkflowTools({ orchestrator: fakeOrchestrator({ cancelSubagent }), availableTools });

    await expect(invoke(tools, "cancelSubagent", { subagentId: "subagent-1" })).resolves.toBe(
      JSON.stringify({ subagentId: "subagent-1", cancelled: true }),
    );
    expect(cancelSubagent).toHaveBeenCalledWith("subagent-1");
  });

  it("rejects cancellation for an unknown or finished subagent", async () => {
    const cancelSubagent = vi.fn(() => false);
    const tools = createWorkflowTools({ orchestrator: fakeOrchestrator({ cancelSubagent }), availableTools });

    await expect(invoke(tools, "cancelSubagent", { subagentId: "subagent-1" })).rejects.toThrow(
      "Subagent subagent-1 was not found or is already finished",
    );
    expect(cancelSubagent).toHaveBeenCalledWith("subagent-1");
  });

  it.each([
    ["spawnSubagent", [], "input must be an object"],
    ["spawnSubagent", { task: "   " }, "task must be a non-empty string"],
    ["spawnSubagent", { task: "work", dependsOn: [" "] }, "dependsOn entries must be non-empty strings"],
    ["spawnSubagent", { task: "work", timeoutMs: 0 }, "timeoutMs must be a positive safe integer"],
    ["spawnSubagent", { task: "work", timeoutMs: 1.5 }, "timeoutMs must be a positive safe integer"],
    ["spawnSubagent", { task: "work", timeoutMs: Number.NaN }, "timeoutMs must be a positive safe integer"],
    ["spawnSubagent", { task: "work", timeoutMs: Infinity }, "timeoutMs must be a positive safe integer"],
    ["waitForSubagents", { subagentIds: [""] }, "subagentIds entries must be non-empty strings"],
    ["cancelSubagent", { subagentId: "  " }, "subagentId must be a non-empty string"],
  ])("rejects invalid %s input before calling the orchestrator", async (name, input, message) => {
    const orchestrator = fakeOrchestrator();
    const tools = createWorkflowTools({ orchestrator, availableTools });

    await expect(invoke(tools, name, input)).rejects.toThrow(message);
    expect(orchestrator.createSubagent).not.toHaveBeenCalled();
    expect(orchestrator.waitForSubagents).not.toHaveBeenCalled();
    expect(orchestrator.cancelSubagent).not.toHaveBeenCalled();
  });
});

const availableTools: ReactAgentTool[] = [{ name: "readFile", description: "Read a file", inputSchema: {}, invoke: () => "" }];

function fakeOrchestrator(overrides: Partial<WorkflowOrchestrator> = {}): WorkflowOrchestrator {
  return {
    createSubagent: vi.fn(() => "subagent-default"),
    waitForSubagents: vi.fn(async () => new Map()),
    getSubagent: vi.fn(),
    cancelSubagent: vi.fn(() => true),
    cancelAll: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    ...overrides,
  };
}

function toolByName(tools: ReactAgentTool[], name: string): ReactAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function invoke(tools: ReactAgentTool[], name: string, input: unknown): Promise<string | object> {
  return Promise.resolve().then(() =>
    toolByName(tools, name).invoke({
      request: { id: "request-1", name, rawArguments: JSON.stringify(input), input },
      input,
      signal: new AbortController().signal,
    }),
  );
}
