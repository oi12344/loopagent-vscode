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
      { subagentId: secondId, toolNames: ["readFile"] },
    ]);
    first.resolve();
    second.resolve();

    const results = await orchestrator.waitForSubagents([firstId, secondId]);
    expect(results.get(firstId)).toMatchObject({ status: "completed", content: `${firstId}:one:two` });
    expect(results.get(secondId)).toMatchObject({ status: "completed", content: `${secondId}:one:two` });
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
    expect(results.get(rootId)).toMatchObject({ status: "failed", error: "root failed" });
    expect(results.get(rootId)?.diagnosticLog).toEqual([{ kind: "error", message: "root failed" }]);
    expect(results.get(childId)).toMatchObject({ status: "cancelled", error: expect.stringContaining(rootId) });
    expect(results.get(grandchildId)).toMatchObject({ status: "cancelled", error: expect.stringContaining(childId) });
    expect(started).toEqual([rootId]);
  });

  it("returns a bounded diagnostic log for a failed subagent", async () => {
    const orchestrator = createWorkflowOrchestrator({
      createRunner: ({ subagentId }) => runner(async function* () {
        yield { type: "assistantThinking", runId: subagentId, message: "Inspecting input" };
        yield { type: "toolCallStarted", runId: subagentId, callId: "call-1", toolName: "readFile", input: "token=sk-secret" };
        yield { type: "toolCallFinished", runId: subagentId, callId: "call-1", succeeded: false, output: "permission denied" };
        yield { type: "runFailed", runId: subagentId, message: "read failed" };
      }),
    });

    const id = orchestrator.createSubagent({ task: "Read diagnostics", role: "explorer" }, tools);
    const result = (await orchestrator.waitForSubagents([id])).get(id);

    expect(result).toMatchObject({ status: "failed", error: "read failed" });
    expect(result?.diagnosticLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", name: "readFile" }),
      expect.objectContaining({ kind: "assistant", message: "Inspecting input" }),
    ]));
    expect(JSON.stringify(result?.diagnosticLog)).not.toContain("sk-secret");
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

	it("runs read-only roles concurrently while allowing only one executor", async () => {
		const releases = new Map<string, ReturnType<typeof deferred<void>>>();
		const started: Array<{ id: string; role: string }> = [];
		let runningExecutors = 0;
		let runningReadOnly = 0;
		let maxExecutors = 0;
		let maxReadOnly = 0;
		const orchestrator = createWorkflowOrchestrator({
			createRunner: ({ subagentId, role }) => runner(async function* () {
				const release = deferred<void>();
				releases.set(subagentId, release);
				started.push({ id: subagentId, role });
				if (role === "executor") maxExecutors = Math.max(maxExecutors, ++runningExecutors);
				else maxReadOnly = Math.max(maxReadOnly, ++runningReadOnly);
				await release.promise;
				if (role === "executor") runningExecutors -= 1;
				else runningReadOnly -= 1;
			}),
			limits: { maxConcurrentSubagents: 4 },
		});

		const executor1 = orchestrator.createSubagent({ task: "Edit one", role: "executor" }, []);
		const executor2 = orchestrator.createSubagent({ task: "Edit two", role: "executor" }, []);
		const explorer = orchestrator.createSubagent({ task: "Explore", role: "explorer" }, []);
		const reviewer = orchestrator.createSubagent({ task: "Review", role: "reviewer" }, []);

		await vi.waitFor(() => expect(started.map(({ id }) => id)).toEqual([executor1, explorer, reviewer]));
		expect(maxExecutors).toBe(1);
		expect(maxReadOnly).toBe(2);

		releases.get(executor1)!.resolve();
		await vi.waitFor(() => expect(started.map(({ id }) => id)).toEqual([executor1, explorer, reviewer, executor2]));
		for (const release of releases.values()) release.resolve();
		await orchestrator.waitForSubagents([executor1, executor2, explorer, reviewer]);
		expect(maxExecutors).toBe(1);
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

    expect((await orchestrator.waitForSubagents([firstId])).get(firstId)).toMatchObject({ status: "cancelled" });
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

    expect((await orchestrator.waitForSubagents([id])).get(id)).toMatchObject({ status: "cancelled" });
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

      expect((await waiting).get(id)).toMatchObject({
        status: "failed",
        error: "Subagent timed out after 25ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a progressing subagent running past the check interval", async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = createWorkflowOrchestrator({
        createRunner: () => runner(async function* ({ runId, signal }) {
          // 每 20ms 产出一条，跨过多个 25ms 检查窗口后正常收尾。
          for (let index = 0; index < 5 && !signal.aborted; index++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield { type: "assistantDelta", runId, content: `step-${index}` };
          }
        }),
        limits: { subagentTimeoutMs: 25, maxSubagentTimeoutMs: 1_000 },
      });
      const id = orchestrator.createSubagent({ task: "Steady work" }, []);
      const waiting = orchestrator.waitForSubagents([id]);

      await vi.advanceTimersByTimeAsync(200);

      expect((await waiting).get(id)).toMatchObject({
        status: "completed",
        content: "step-0step-1step-2step-3step-4",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a subagent running while a tool call is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = createWorkflowOrchestrator({
        createRunner: () => runner(async function* ({ runId, signal }) {
          yield { type: "toolCallStarted", runId, callId: "c1", toolName: "runCommand", input: "npm test" };
          // 命令跑 80ms，横跨三个检查窗口且期间不产生任何消息。
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (signal.aborted) return;
          yield { type: "toolCallFinished", runId, callId: "c1", succeeded: true, output: "ok" };
          yield { type: "assistantDelta", runId, content: "tests pass" };
        }),
        limits: { subagentTimeoutMs: 25, maxSubagentTimeoutMs: 1_000 },
      });
      const id = orchestrator.createSubagent({ task: "Run tests" }, []);
      const waiting = orchestrator.waitForSubagents([id]);

      await vi.advanceTimersByTimeAsync(200);

      expect((await waiting).get(id)).toMatchObject({ status: "completed", content: "tests pass" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a subagent that repeats the same tool call", async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = createWorkflowOrchestrator({
        createRunner: () => runner(async function* ({ runId, signal }) {
          for (let index = 0; !signal.aborted; index++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield { type: "toolCallStarted", runId, callId: `c${index}`, toolName: "exploreCode", input: "auth" };
            yield { type: "toolCallFinished", runId, callId: `c${index}`, succeeded: true, output: "same" };
          }
        }),
        limits: { subagentTimeoutMs: 50, maxSubagentTimeoutMs: 5_000 },
      });
      const id = orchestrator.createSubagent({ task: "Loop forever" }, []);
      const waiting = orchestrator.waitForSubagents([id]);

      await vi.advanceTimersByTimeAsync(100);
      const result = (await waiting).get(id);

      expect(result?.status).toBe("failed");
      expect(result?.error).toContain("stopped making progress");
      expect(result?.error).toContain("exploreCode");
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip("stops a chatty subagent once the absolute ceiling is reached", async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = createWorkflowOrchestrator({
        createRunner: () => runner(async function* ({ runId, signal }) {
          // 一直产出不同内容：进度判定永远是 progressing，只有硬上限能拦住它。
          for (let index = 0; !signal.aborted; index++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield { type: "assistantDelta", runId, content: `chunk-${index}` };
          }
        }),
        limits: { subagentTimeoutMs: 25, maxSubagentTimeoutMs: 100 },
      });
      const id = orchestrator.createSubagent({ task: "Never converge" }, []);
      const waiting = orchestrator.waitForSubagents([id]);

      // 推进足够的时间以触发绝对上限
      await vi.advanceTimersByTimeAsync(150);
      const result = (await waiting).get(id);

      // 验证子代理因超时失败
      expect(result?.status).toBe("failed");
      expect(result?.error).toMatch(/timed out|reached.*limit/);
    } finally {
      orchestrator.cancelAll();
      vi.useRealTimers();
    }
  }, 15000); // Increase timeout to 15s

  it("allows a 60 second timeout at the default workflow limit", async () => {
    vi.useFakeTimers();
    const orchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* ({ signal }) {
        await aborted(signal);
      }),
    });
    const id = orchestrator.createSubagent({ task: "Slow", timeoutMs: 60_000 }, []);
    const waiting = orchestrator.waitForSubagents([id]);
    let settled = false;
    void waiting.then(() => { settled = true; });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(true);
      expect((await waiting).get(id)).toMatchObject({
        status: "failed",
        error: "Subagent timed out after 60000ms",
      });
    } finally {
      orchestrator.cancelAll();
      await waiting;
      vi.useRealTimers();
    }
  });

  it("passes the resolved role to the runner factory", async () => {
    const factoryInputs: Array<{ subagentId: string; role: string }> = [];
    const orchestrator = createWorkflowOrchestrator({
      createRunner(input) {
        factoryInputs.push({ subagentId: input.subagentId, role: input.role });
        return runner(async function* () {});
      },
    });

    const explorerId = orchestrator.createSubagent({ task: "Find symbols" }, []);
    const reviewerId = orchestrator.createSubagent({ task: "Review code", role: "reviewer" }, []);
    await orchestrator.waitForSubagents([explorerId, reviewerId]);

    expect(factoryInputs[0]).toMatchObject({ subagentId: explorerId, role: "explorer" });
    expect(factoryInputs[1]).toMatchObject({ subagentId: reviewerId, role: "reviewer" });
  });

  it("stores the resolved role in the subagent snapshot", () => {
    const orchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* () {}),
    });
    const id = orchestrator.createSubagent({ task: "Plan steps", role: "planner" }, []);
    expect(orchestrator.getSubagent(id)?.role).toBe("planner");
  });

  it("rejects creation when an unknown role is requested", () => {
    const orchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* () {}),
    });
    expect(() => orchestrator.createSubagent({ task: "Task", role: "unknown" as never }, [])).toThrow(/unknown/i);
  });

  it("restricts tools to the role whitelist when selecting for a subagent", async () => {
    const factoryInputs: Array<{ subagentId: string; toolNames: string[] }> = [];
    const allTools: ReactAgentTool[] = [
      { name: "exploreCode", description: "Search code", inputSchema: {}, invoke: () => "" },
      { name: "readFile", description: "Read files", inputSchema: {}, invoke: () => "" },
      { name: "applyEdit", description: "Apply edit", inputSchema: {}, invoke: () => "" },
    ];
    const orchestrator = createWorkflowOrchestrator({
      createRunner(input) {
        factoryInputs.push({ subagentId: input.subagentId, toolNames: input.tools.map((t) => t.name) });
        return runner(async function* () {});
      },
    });
    const id = orchestrator.createSubagent({ task: "Explore the codebase", role: "explorer" }, allTools);
    await orchestrator.waitForSubagents([id]);
    expect(factoryInputs[0]?.toolNames).not.toContain("applyEdit");
  });

  it("returns false when cancelling an unknown or completed subagent", async () => {
    const orchestrator = createWorkflowOrchestrator({ createRunner: () => runner(async function* () {}) });

    expect(orchestrator.cancelSubagent("missing")).toBe(false);
    const id = orchestrator.createSubagent({ task: "Complete" }, []);
    await orchestrator.waitForSubagents([id]);
    expect(orchestrator.cancelSubagent(id)).toBe(false);
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
    expect([...results.values()]).toMatchObject([
      { status: "cancelled" },
      { status: "cancelled" },
    ]);
    expect(childSignals.every((signal) => signal.aborted)).toBe(true);
    releaseRunners.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runCalls).toBe(0);
  });

  it("owns the run-scoped tool invocation and cancels active calls", async () => {
    let observedSignal: AbortSignal | undefined;
    const tool: ReactAgentTool = {
      name: "runScopedTool",
      description: "Waits until the coordinator cancels the call.",
      inputSchema: {},
      invoke: ({ signal }) => new Promise<string>((resolve) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => resolve("cancelled by coordinator"), { once: true });
      }),
    };
    const orchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* () {}),
    });
    const pending = orchestrator.invokeTool(
      [tool],
      { id: "tool-1", name: "runScopedTool", rawArguments: "{}", input: {} },
      new AbortController().signal,
    );

    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    orchestrator.cancelAll();

    await expect(pending).resolves.toEqual({ content: "cancelled by coordinator", evidence: [] });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects a tool that is outside the current invocation set", async () => {
    const orchestrator = createWorkflowOrchestrator({
      createRunner: () => runner(async function* () {}),
    });

    await expect(orchestrator.invokeTool(
      [],
      { id: "tool-1", name: "missingTool", rawArguments: "{}", input: {} },
      new AbortController().signal,
    )).rejects.toThrow("Unknown tool: missingTool");
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
