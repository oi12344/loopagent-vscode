import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";
import { openProjectMemory, type ProjectMemory } from "../../src/extension/memory/projectMemory";
import type { ReadRange } from "../../src/extension/memory/types";
import type { ReactAgentTool } from "../../src/extension/agent/reactTypes";

const openedMemories: ProjectMemory[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const memory of openedMemories.splice(0).reverse()) memory.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const noopReadRange: ReadRange = () => "";

function createMemoryFixture(): { databasePath: string; workspaceKey: string; memory: ProjectMemory } {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-workflow-orchestrator-memory-"));
  directories.push(directory);
  const databasePath = join(directory, "memory.sqlite");
  const workspaceKey = "workspace-a";
  const memory = openProjectMemory(databasePath, workspaceKey, noopReadRange);
  openedMemories.push(memory);
  return { databasePath, workspaceKey, memory };
}

function readTaskRuns(databasePath: string): { outcome: string; task_summary: string; summary: string }[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare("SELECT outcome, task_summary, summary FROM task_runs").all() as {
      outcome: string;
      task_summary: string;
      summary: string;
    }[];
  } finally {
    raw.close();
  }
}

const mockTools: ReactAgentTool[] = [];

function mockRunner(content: string) {
  return vi.fn().mockResolvedValue({
    run: async function* () {
      yield { type: "assistantDelta", content };
    },
  });
}

function failingRunner(message: string) {
  return vi.fn().mockResolvedValue({
    run: async function* () {
      yield { type: "runFailed", message };
    },
  });
}

describe("WorkflowOrchestrator subagent memory recording (T11)", () => {
  it("records a completed subagent run as a task_runs row", async () => {
    const { databasePath, memory } = createMemoryFixture();
    const orchestrator = createWorkflowOrchestrator({
      createRunner: mockRunner("subagent output"),
      projectMemory: memory,
    });

    const id = orchestrator.createSubagent({ task: "summarize the changelog" }, mockTools);
    await orchestrator.waitForSubagents([id]);

    // recordOutcome() is fire-and-forget from settle(); give its microtask a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = readTaskRuns(databasePath);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "completed", task_summary: "summarize the changelog" });
  });

  it("records a failed subagent run as a task_runs row", async () => {
    const { databasePath, memory } = createMemoryFixture();
    const orchestrator = createWorkflowOrchestrator({
      createRunner: failingRunner("tool exploded"),
      projectMemory: memory,
    });

    const id = orchestrator.createSubagent({ task: "attempt a risky migration" }, mockTools);
    await orchestrator.waitForSubagents([id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = readTaskRuns(databasePath);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("failed");
  });

  it("does not record a cancelled subagent run", async () => {
    const { databasePath, memory } = createMemoryFixture();
    const orchestrator = createWorkflowOrchestrator({
      createRunner: mockRunner("irrelevant"),
      projectMemory: memory,
    });

    const id = orchestrator.createSubagent({ task: "long running task" }, mockTools);
    orchestrator.cancelSubagent(id);
    await orchestrator.waitForSubagents([id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readTaskRuns(databasePath)).toEqual([]);
  });

  it("redacts sensitive content in the recorded summary via sanitizeSummary", async () => {
    const { databasePath, memory } = createMemoryFixture();
    const orchestrator = createWorkflowOrchestrator({
      createRunner: mockRunner("api_key: sk-abcdefgh12345678"),
      projectMemory: memory,
    });

    const id = orchestrator.createSubagent({ task: "print the api key" }, mockTools);
    await orchestrator.waitForSubagents([id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = readTaskRuns(databasePath);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.summary).not.toContain("sk-abcdefgh12345678");
    expect(runs[0]?.summary).toBe("[redacted: sensitive content omitted]");
  });

  it("never records anything when projectMemory is not provided (backward compatible)", async () => {
    const orchestrator = createWorkflowOrchestrator({
      createRunner: mockRunner("subagent output"),
    });

    const id = orchestrator.createSubagent({ task: "no memory wired" }, mockTools);
    const results = await orchestrator.waitForSubagents([id]);

    expect(results.get(id)?.status).toBe("completed");
  });
});
