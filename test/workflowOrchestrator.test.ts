import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import {
  createWorkflowOrchestrator,
  type WorkflowEvent,
} from "../src/extension/agent/workflowOrchestrator";

describe("workflow orchestrator", () => {
  it("starts independent tasks concurrently, selects tools, publishes messages, and aggregates content", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const releases = [first, second];
    const started: string[] = [];
    const factoryInputs: Array<{ subagentId: string; toolNames: string[] }> = [];
    const events: WorkflowEvent[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner(input) {
        const index = factoryInputs.length;
        factoryInputs.push({ subagentId: input.subagentId, toolNames: input.tools.map((tool) => tool.name) });
        return runner(async function* ({ runId }) {
          started.push(runId);
          await releases[index].promise;
          yield { type: "assistantDelta", runId, content: `${runId}:one` };
          yield { type: "assistantDelta", runId, content: ":two" };
        });
      },
      limits: { maxConcurrentSubagents: 2 },
    });
    orchestrator.onEvent((event) => events.push(event));

    const firstId = orchestrator.createSubagent({ task: "Read source", toolHints: ["readFile"] }, tools);
    const secondId = orchestrator.createSubagent({ task: "Write source", toolHints: ["writeFile"] }, tools);

    await vi.waitFor(() => expect(started).toEqual([firstId, secondId]));
    expect(factoryInputs).toEqual([
      { subagentId: firstId, toolNames: ["readFile"] },
      { subagentId: secondId, toolNames: ["writeFile"] },
    ]);
    first.resolve();
    second.resolve();

    const results = await orchestrator.waitForSubagents([firstId, secondId]);
    expect(results.get(firstId)).toEqual({ status: "completed", content: `${firstId}:one:two` });
    expect(results.get(secondId)).toEqual({ status: "completed", content: `${secondId}:one:two` });
    expect(events.filter((event) => event.type === "SubagentCreated")).toHaveLength(2);
    expect(events.filter((event) => event.type === "SubagentMessage")).toHaveLength(4);
    expect(orchestrator.getSubagent(firstId)?.status).toBe("completed");
  });

  it("starts a dependent only after every dependency completes", async () => {
    const releaseRoot = deferred<void>();
    const started: string[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner: ({ subagentId }) => runner(async function* () {
        started.push(subagentId);
        if (subagentId === "subagent-1") await releaseRoot.promise;
      }),
    });

    const rootId = orchestrator.createSubagent({ task: "Root" }, []);
    const childId = orchestrator.createSubagent({ task: "Child", dependsOn: [rootId] }, []);

    await vi.waitFor(() => expect(started).toEqual([rootId]));
    releaseRoot.resolve();
    await orchestrator.waitForSubagents([rootId, childId]);
    expect(started).toEqual([rootId, childId]);
  });

  it("recursively cancels pending dependents when a dependency fails", async () => {
    const releaseFailure = deferred<void>();
    const started: string[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner: ({ subagentId }) => runner(async function* ({ runId }) {
        started.push(subagentId);
        await releaseFailure.promise;
        yield { type: "runFailed", runId, message: "root failed" };
      }),
    });

    const rootId = orchestrator.createSubagent({ task: "Root" }, []);
    const childId = orchestrator.createSubagent({ task: "Child", dependsOn: [rootId] }, []);
    const grandchildId = orchestrator.createSubagent({ task: "Grandchild", dependsOn: [childId] }, []);
    releaseFailure.resolve();

    const results = await orchestrator.waitForSubagents([rootId, childId, grandchildId]);
    expect(results.get(rootId)).toEqual({ status: "failed", error: "root failed" });
    expect(results.get(childId)).toMatchObject({ status: "cancelled", error: expect.stringContaining(rootId) });
    expect(results.get(grandchildId)).toMatchObject({ status: "cancelled", error: expect.stringContaining(childId) });
    expect(started).toEqual([rootId]);
  });

  it("enforces count, depth, and concurrency limits", async () => {
    const releases = [deferred<void>(), deferred<void>()];
    const started: string[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner: ({ subagentId }) => runner(async function* () {
        const index = started.push(subagentId) - 1;
        await releases[index].promise;
      }),
      limits: { maxConcurrentSubagents: 1, maxSubagentsPerRun: 2 },
    });

    const firstId = orchestrator.createSubagent({ task: "First" }, []);
    const secondId = orchestrator.createSubagent({ task: "Second" }, []);
    expect(() => orchestrator.createSubagent({ task: "Third" }, [])).toThrow("Max subagents per run (2) exceeded");
    await vi.waitFor(() => expect(started).toEqual([firstId]));
    releases[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([firstId, secondId]));
    releases[1].resolve();
    await orchestrator.waitForSubagents([firstId, secondId]);

    const depthOrchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* () {}),
      limits: { maxNestingDepth: 2 },
    });
    const rootId = depthOrchestrator.createSubagent({ task: "Root" }, []);
    const childId = depthOrchestrator.createSubagent({ task: "Child", dependsOn: [rootId] }, []);
    expect(() => depthOrchestrator.createSubagent({ task: "Too deep", dependsOn: [childId] }, [])).toThrow(
      "Subagent nesting depth (3) exceeds limit (2)",
    );
    expect(() => depthOrchestrator.createSubagent({ task: "Unknown", dependsOn: ["missing"] }, [])).toThrow(
      "Unknown dependency: missing",
    );
  });

  it("keeps a cancelled runner in the concurrency slot until it exits", async () => {
    const abortObserved = deferred<void>();
    const releaseCancelledRunner = deferred<void>();
    const started: string[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner: ({ subagentId }) => runner(async function* ({ signal }) {
        started.push(subagentId);
        if (subagentId === "subagent-1") {
          await aborted(signal);
          abortObserved.resolve();
          await releaseCancelledRunner.promise;
        }
      }),
      limits: { maxConcurrentSubagents: 1 },
    });
    const firstId = orchestrator.createSubagent({ task: "First" }, []);
    const secondId = orchestrator.createSubagent({ task: "Second" }, []);
    await vi.waitFor(() => expect(started).toEqual([firstId]));

    orchestrator.cancelSubagent(firstId);

    expect((await orchestrator.waitForSubagents([firstId])).get(firstId)).toEqual({ status: "cancelled" });
    await abortObserved.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([firstId]);

    releaseCancelledRunner.resolve();
    await orchestrator.waitForSubagents([secondId]);
    expect(started).toEqual([firstId, secondId]);
  });

  it("isolates listener errors from creation, scheduling, and other listeners", async () => {
    const observed: WorkflowEvent[] = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* () {}),
      limits: { maxConcurrentSubagents: 1 },
    });
    orchestrator.onEvent(() => {
      throw new Error("listener failed");
    });
    orchestrator.onEvent((event) => observed.push(event));

    let firstId = "";
    expect(() => {
      firstId = orchestrator.createSubagent({ task: "First" }, []);
    }).not.toThrow();
    const secondId = orchestrator.createSubagent({ task: "Second" }, []);

    const results = await orchestrator.waitForSubagents([firstId, secondId]);
    expect([...results.values()].map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(observed.filter((event) => event.type === "SubagentCreated")).toHaveLength(2);
    expect(observed.filter((event) => event.type === "SubagentStatusChanged")).toHaveLength(4);
  });

  it("does not create a runner when a running listener cancels the task", async () => {
    const createRunner = vi.fn(() => runner(async function* () {}));
    const orchestrator = createWorkflowOrchestrator({ createRunner });
    orchestrator.onEvent((event) => {
      if (event.type === "SubagentStatusChanged" && event.status === "running") {
        orchestrator.cancelSubagent(event.subagentId);
      }
    });

    const id = orchestrator.createSubagent({ task: "Cancel during start" }, []);

    expect((await orchestrator.waitForSubagents([id])).get(id)).toEqual({ status: "cancelled" });
    expect(createRunner).not.toHaveBeenCalled();
  });

  it("fails a task that exceeds its timeout", async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = createWorkflowOrchestrator({
        createRunner: () => runner(async function* ({ signal }) {
          await aborted(signal);
        }),
        limits: { subagentTimeoutMs: 25 },
      });
      const id = orchestrator.createSubagent({ task: "Slow" }, []);
      const waiting = orchestrator.waitForSubagents([id]);

      await vi.advanceTimersByTimeAsync(25);

      expect((await waiting).get(id)).toEqual({
        status: "failed",
        error: "Subagent timed out after 25ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels every task when the parent signal aborts", async () => {
    const parent = new AbortController();
    const releaseRunners = deferred<void>();
    const childSignals: AbortSignal[] = [];
    let runCalls = 0;
    const orchestrator = createWorkflowOrchestrator({
      signal: parent.signal,
      async createRunner({ signal }) {
        childSignals.push(signal);
        await releaseRunners.promise;
        return runner(async function* () {
          runCalls += 1;
          await aborted(signal);
        });
      },
      limits: { maxConcurrentSubagents: 2 },
    });
    const firstId = orchestrator.createSubagent({ task: "First" }, []);
    const secondId = orchestrator.createSubagent({ task: "Second" }, []);
    await vi.waitFor(() => expect(childSignals).toHaveLength(2));

    parent.abort();

    const results = await orchestrator.waitForSubagents([firstId, secondId]);
    expect([...results.values()]).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
    expect(childSignals.every((signal) => signal.aborted)).toBe(true);
    releaseRunners.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runCalls).toBe(0);
  });
});

const tools: ReactAgentTool[] = [
  { name: "readFile", description: "Read source files", inputSchema: {}, invoke: () => "" },
  { name: "writeFile", description: "Write source files", inputSchema: {}, invoke: () => "" },
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

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
