import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import { createWorkflowOrchestrator, type WorkflowEvent } from "../src/extension/agent/workflowOrchestrator";
import { createWorkflowTools } from "../src/extension/agent/workflowTools";

describe("workflow end to end", () => {
  it("creates concurrent routed subagents, unlocks dependencies, and aggregates their results", async () => {
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: string[] = [];
    const runnerInputs: Array<{ subagentId: string; toolNames: string[] }> = [];
    const events: WorkflowEvent[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner({ subagentId, tools }) {
        const index = runnerInputs.length;
        runnerInputs.push({ subagentId, toolNames: tools.map((tool) => tool.name) });
        return runner(async function* ({ runId }) {
          started.push(subagentId);
          await releases[index].promise;
          yield { type: "assistantDelta", runId, content: `${runId}: done` };
        });
      },
      limits: { maxConcurrentSubagents: 2 },
    });
    const workflowTools = createWorkflowTools({ orchestrator, availableTools });
    orchestrator.onEvent((event) => events.push(event));

    const firstId = await spawn(workflowTools, { task: "Read source", toolHints: ["readFile"] });
    const secondId = await spawn(workflowTools, { task: "Write source", toolHints: ["writeFile"] });
    const dependentId = await spawn(workflowTools, {
      task: "Read follow-up source",
      dependsOn: [firstId],
      toolHints: ["readFile"],
    });

    await vi.waitFor(() => expect(started).toEqual([firstId, secondId]));
    expect(runnerInputs).toEqual([
      { subagentId: firstId, toolNames: ["readFile"] },
      { subagentId: secondId, toolNames: ["readFile"] },
    ]);
    releases[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([firstId, secondId, dependentId]));
    const firstCompleted = events.findIndex(
      (event) => event.type === "SubagentStatusChanged" && event.subagentId === firstId && event.status === "completed",
    );
    const dependentRunning = events.findIndex(
      (event) => event.type === "SubagentStatusChanged" && event.subagentId === dependentId && event.status === "running",
    );
    expect(firstCompleted).toBeGreaterThanOrEqual(0);
    expect(dependentRunning).toBeGreaterThan(firstCompleted);
    releases[1].resolve();
    releases[2].resolve();

    await expect(wait(workflowTools, [firstId, secondId, dependentId])).resolves.toEqual({
      results: {
        [firstId]: { status: "completed", content: `${firstId}: done` },
        [secondId]: { status: "completed", content: `${secondId}: done` },
        [dependentId]: { status: "completed", content: `${dependentId}: done` },
      },
    });
    expect(events.filter((event) => event.type === "SubagentCreated")).toHaveLength(3);
    expect(events.filter((event) => event.type === "SubagentStatusChanged" && event.status === "running")).toHaveLength(3);
    expect(events.filter((event) => event.type === "SubagentStatusChanged" && event.status === "completed")).toHaveLength(3);
  });

  it("routes tools by role whitelist and passes the resolved role to each runner", async () => {
    const runnerInputs: Array<{ role: string; toolNames: string[] }> = [];
    const allTools: ReactAgentTool[] = [
      ...availableTools,
      { name: "exploreCode", description: "Search code", inputSchema: {}, invoke: () => "" },
    ];
    const orchestrator = createWorkflowOrchestrator({
      createRunner({ role, tools }) {
        runnerInputs.push({ role, toolNames: tools.map((t) => t.name) });
        return runner(async function* ({ runId }) {
          yield { type: "assistantDelta", runId, content: "done" };
        });
      },
    });
    const workflowTools = createWorkflowTools({ orchestrator, availableTools: allTools });

    const explorerId = await spawn(workflowTools, { task: "Explore the codebase", role: "explorer" });
    const reviewerId = await spawn(workflowTools, { task: "Review the code", role: "reviewer" });
    await wait(workflowTools, [explorerId, reviewerId]);

    expect(runnerInputs[0]).toMatchObject({ role: "explorer" });
    expect(runnerInputs[1]).toMatchObject({ role: "reviewer" });
    for (const { toolNames } of runnerInputs) {
      expect(toolNames).not.toContain("writeFile");
      expect(toolNames).not.toContain("runCommand");
    }
  });
});

const availableTools: ReactAgentTool[] = [
  { name: "readFile", description: "Read a source file", inputSchema: {}, invoke: () => "" },
  { name: "writeFile", description: "Write a source file", inputSchema: {}, invoke: () => "" },
  { name: "runCommand", description: "Run an approved command", inputSchema: {}, invoke: () => "" },
];

function runner(run: AgentRunner["run"]): AgentRunner {
  return { run };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function spawn(tools: ReactAgentTool[], input: unknown): Promise<string> {
  const content = await invoke(tools, "spawnSubagent", input);
  return (JSON.parse(content) as { subagentId: string }).subagentId;
}

async function wait(tools: ReactAgentTool[], subagentIds: string[]): Promise<unknown> {
  return JSON.parse(await invoke(tools, "waitForSubagents", { subagentIds }));
}

async function invoke(tools: ReactAgentTool[], name: string, input: unknown): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  const result = await tool.invoke({
    request: { id: "request-1", name, rawArguments: JSON.stringify(input), input },
    input,
    signal: new AbortController().signal,
  });
  if (typeof result !== "string") throw new Error(`Expected string response from ${name}`);
  return result;
}
