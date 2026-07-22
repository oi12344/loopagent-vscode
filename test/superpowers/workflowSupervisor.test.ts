import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ReactAgentTool } from "../../src/extension/agent/reactTypes";
import type { AgentPool, AgentRole, SubagentResult } from "../../src/extension/superpowers/agentPool";
import { createReviewResultBridge, createSuperpowersAgentTools } from "../../src/extension/superpowers/superpowersAgentRunner";
import { createWorkflowSupervisor } from "../../src/extension/superpowers/workflowSupervisor";
import type { WorkflowStore } from "../../src/extension/superpowers/workflowStore";
import type { SuperpowersCheckpoint } from "../../src/shared/chatTypes";

const SKILLS = [
  "using-superpowers",
  "brainstorming",
  "writing-plans",
  "subagent-driven-development",
  "test-driven-development",
  "requesting-code-review",
  "verification-before-completion",
];

describe("WorkflowSupervisor", () => {
  it("runs implement, review, fix, rereview, and final review in order", async () => {
    const roles: AgentRole[] = [];
    const reviews = createReviewResultBridge();
    const pool: AgentPool = {
      async dispatch(request) {
        roles.push(request.role);
        if (request.role === "taskReviewer" || request.role === "finalReviewer") {
          await invoke(createSuperpowersAgentTools({
            agentId: request.agentId,
            reviewBridge: reviews,
            catalog: emptyCatalog(),
            resourceRoot: tmpdir(),
          }), "reportReview", review(roles.filter((role) => role === "taskReviewer").length));
        }
        return done();
      },
      cancelAll() {},
    };
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({ agentPool: reviews.wrap(pool), workflowStore: store, model: "model" });

    const messages = await collect(supervisor.run({
      runId: "run-1",
      task: "Implement the requested change",
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      resumeState: { kind: "superpowers", checkpoint: checkpoint("preflight") } as never,
    }));

    expect(roles).toEqual(["implementer", "taskReviewer", "fixer", "taskReviewer", "finalReviewer"]);
    expect(messages.at(-1)).toEqual({ type: "runFinished", runId: "run-1" });
    expect(store.load("conversation-1")?.phase).toBe("finished");
  });

  it("automatically advances approval checkpoints without interrupting", async () => {
    const store = memoryStore();
    const roles: AgentRole[] = [];
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch(request) {
          roles.push(request.role);
          return request.role === "taskReviewer" || request.role === "finalReviewer"
            ? { ...done(), review: review(2) }
            : done();
        },
        cancelAll() {},
      },
      workflowStore: store,
      model: "model",
      loadSkill: async (name) => name,
    });
    const request = (runId: string, resumeState?: unknown) => ({
      runId,
      task: "Add a small feature",
      conversationId: "conversation-2",
      signal: new AbortController().signal,
      ...(resumeState ? { resumeState } : {}),
    });

    const runs = [
      request("run-1"),
      ...(["designApproval", "specReview", "planApproval"] as const).map((phase, index) =>
        request(`run-${index + 2}`, { kind: "superpowers", checkpoint: { ...checkpoint(phase), conversationId: "conversation-2" } } as never)),
    ];

    for (const run of runs) {
      const messages = await collect(supervisor.run(run));
      expect(messages.some((message) => message.type === "runInterrupted")).toBe(false);
      expect(messages.at(-1)).toEqual({ type: "runFinished", runId: run.runId });
    }
    expect(store.load("conversation-2")).toMatchObject({ phase: "finished", waitingFor: undefined, skillNames: SKILLS });
    expect(roles).toEqual(Array.from({ length: 4 }, () => ["implementer", "taskReviewer", "finalReviewer"]).flat());
  });

  it("resumes the interrupted phase after cancellation", async () => {
    const controller = new AbortController();
    const roles: AgentRole[] = [];
    let cancelFirstDispatch = true;
    let waitingDuringResume: string | undefined = "unset";
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch(request) {
          roles.push(request.role);
          if (cancelFirstDispatch) {
            cancelFirstDispatch = false;
            controller.abort();
          } else {
            waitingDuringResume = store.load("conversation-1")?.waitingFor;
          }
          return request.role === "taskReviewer" || request.role === "finalReviewer"
            ? { ...done(), review: review(2) }
            : done();
        },
        cancelAll() {},
      },
      workflowStore: store,
      model: "model",
    });

    const messages = await collect(supervisor.run({
      runId: "run-1",
      task: "Implement safely",
      conversationId: "conversation-1",
      signal: controller.signal,
      resumeState: { kind: "superpowers", checkpoint: checkpoint("preflight") } as never,
    }));

    expect(roles).toEqual(["implementer"]);
    expect(messages).toContainEqual({ type: "runFailed", runId: "run-1", message: "Superpowers workflow cancelled" });
    expect(store.load("conversation-1")).toMatchObject({ phase: "implement", activeAgentId: undefined, waitingFor: "cancelled" });

    const resumed = await collect(supervisor.run({
      ...runFrom("implement"),
      runId: "run-2",
      resumeState: { kind: "superpowers", checkpoint: store.load("conversation-1") } as never,
    }));

    expect(roles).toEqual(["implementer", "implementer", "taskReviewer", "finalReviewer"]);
    expect(waitingDuringResume).toBeUndefined();
    expect(resumed.at(-1)).toEqual({ type: "runFinished", runId: "run-2" });
    expect(store.load("conversation-1")).toMatchObject({ phase: "finished", activeAgentId: undefined, waitingFor: undefined });
  });

  it("blocks before implementation when preflight detects a plan conflict", async () => {
    let dispatched = false;
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: { dispatch: async () => { dispatched = true; return done(); }, cancelAll() {} },
      workflowStore: store,
      model: "model",
      validatePlan: (current) => current.planPath ? "plan conflicts with the current branch" : undefined,
    });

    await collect(supervisor.run({
      runId: "run-1",
      task: "Implement safely",
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      resumeState: { kind: "superpowers", checkpoint: { ...checkpoint("preflight"), planPath: "docs/superpowers/plans/current.md" } } as never,
    }));

    expect(dispatched).toBe(false);
    expect(store.load("conversation-1")).toMatchObject({ phase: "blocked", waitingFor: "plan conflicts with the current branch" });
  });

  it("retries one agent after supplying requested context", async () => {
    let calls = 0;
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch() {
          calls++;
          return calls === 1 ? { ...done(), status: "NEEDS_CONTEXT", summary: "need the affected path" } : done();
        },
        cancelAll() {},
      },
      workflowStore: memoryStore(),
      model: "model",
      provideContext: () => "The affected path is src/example.ts.",
    });

    await collect(supervisor.run({
      runId: "run-1",
      task: "Implement safely",
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      resumeState: { kind: "superpowers", checkpoint: checkpoint("preflight") } as never,
    }));

    expect(calls).toBe(3);
  });

  it("blocks a reviewer that does not submit reportReview data", async () => {
    const roles: AgentRole[] = [];
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch(request) { roles.push(request.role); return done(); },
        cancelAll() {},
      },
      workflowStore: store,
      model: "model",
    });

    await collect(supervisor.run(runFrom("preflight")));

    expect(roles).toEqual(["implementer", "taskReviewer"]);
    expect(store.load("conversation-1")).toMatchObject({ phase: "blocked", waitingFor: "review result is incomplete" });
  });

  it("loads skill bodies into every subagent dispatch context", async () => {
    const contexts: string[] = [];
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch(request) {
          contexts.push(request.context ?? "");
          return done();
        },
        cancelAll() {},
      },
      workflowStore: memoryStore(),
      model: "model",
      loadSkill: async (name) => `# ${name}\nSkill body for ${name}`,
    });

    await collect(supervisor.run(runFrom("preflight")));

    expect(contexts[0]).toContain("# using-superpowers");
    expect(contexts[0]).toContain("# brainstorming");
  });

  it("allows a fresh preflight in an empty workspace", async () => {
    const workspaceRoot = createWorkspace();
    let dispatched = false;
    try {
      const store = memoryStore();
      const supervisor = createWorkflowSupervisor({
        agentPool: { dispatch: async () => { dispatched = true; return done(); }, cancelAll() {} },
        workflowStore: store,
        model: "model",
        workspaceRoot,
        loadSkill: async (name) => name,
      });
      const request = (runId: string, resumeState?: unknown) => ({
        runId,
        task: "Implement safely",
        conversationId: "conversation-1",
        signal: new AbortController().signal,
        ...(resumeState ? { resumeState } : {}),
      });

      await collect(supervisor.run(request("run-1")));
      await collect(supervisor.run(request("run-2", { kind: "superpowers", checkpoint: store.load("conversation-1") } as never)));
      await collect(supervisor.run(request("run-3", { kind: "superpowers", checkpoint: store.load("conversation-1") } as never)));
      await collect(supervisor.run(request("run-4", { kind: "superpowers", checkpoint: store.load("conversation-1") } as never)));

      expect(dispatched).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", "docs/superpowers/plans/missing.md", /does not exist/i],
    ["outside the workspace", "../outside.md", /outside the workspace/i],
    ["empty", "docs/superpowers/plans/empty.md", /empty/i],
  ])("blocks a resumed workflow whose declared plan is %s", async (_case, planPath, expected) => {
    const workspaceRoot = createWorkspace();
    const store = memoryStore();
    try {
      if (planPath.includes("empty")) {
        mkdirSync(join(workspaceRoot, "docs", "superpowers", "plans"), { recursive: true });
        writeFileSync(join(workspaceRoot, planPath), "");
      }
      const supervisor = createWorkflowSupervisor({
        agentPool: { dispatch: async () => done(), cancelAll() {} },
        workflowStore: store,
        model: "model",
        workspaceRoot,
      });

      await collect(supervisor.run(runFrom("preflight", { planPath })));

      expect(store.load("conversation-1")).toMatchObject({ phase: "blocked" });
      expect(store.load("conversation-1")?.waitingFor).toMatch(expected);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("blocks a resumed task with progress when its ledger is missing", async () => {
    const workspaceRoot = createWorkspace();
    const store = memoryStore();
    try {
      const supervisor = createWorkflowSupervisor({
        agentPool: { dispatch: async () => done(), cancelAll() {} },
        workflowStore: store,
        model: "model",
        workspaceRoot,
      });

      await collect(supervisor.run(runFrom("preflight", { taskIndex: 1 })));

      expect(store.load("conversation-1")).toMatchObject({ phase: "blocked" });
      expect(store.load("conversation-1")?.waitingFor).toMatch(/ledger.*does not exist/i);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("continues a resumed task when its declared plan and ledger are valid", async () => {
    const workspaceRoot = createWorkspace();
    let dispatched = false;
    try {
      mkdirSync(join(workspaceRoot, "docs", "superpowers", "plans"), { recursive: true });
      mkdirSync(join(workspaceRoot, ".superpowers", "sdd"), { recursive: true });
      writeFileSync(join(workspaceRoot, "docs", "superpowers", "plans", "current.md"), "# Plan\n");
      writeFileSync(join(workspaceRoot, ".superpowers", "sdd", "progress.md"), "# Progress\n");
      const supervisor = createWorkflowSupervisor({
        agentPool: { dispatch: async () => { dispatched = true; return done(); }, cancelAll() {} },
        workflowStore: memoryStore(),
        model: "model",
        workspaceRoot,
      });

      await collect(supervisor.run(runFrom("preflight", { planPath: "docs/superpowers/plans/current.md", taskIndex: 1 })));

      expect(dispatched).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("clears the active agent and emits failure when dispatch throws", async () => {
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: { dispatch: async () => { throw new Error("agent unavailable"); }, cancelAll() {} },
      workflowStore: store,
      model: "model",
    });

    const messages = await collect(supervisor.run(runFrom("preflight")));

    expect(messages).toContainEqual({ type: "runFailed", runId: "run-1", message: "agent unavailable" });
    expect(store.load("conversation-1")).toMatchObject({ phase: "blocked", activeAgentId: undefined, waitingFor: "agent unavailable" });
  });

  it("rejects an invalid superpowers resume checkpoint", async () => {
    const supervisor = createWorkflowSupervisor({
      agentPool: { dispatch: async () => done(), cancelAll() {} },
      workflowStore: memoryStore(),
      model: "model",
    });

    const messages = await collect(supervisor.run({
      ...runFrom("preflight"),
      resumeState: { kind: "superpowers", checkpoint: { ...checkpoint("preflight"), version: 2 } } as never,
    }));

    expect(messages).toEqual([{ type: "runFailed", runId: "run-1", message: "Invalid Superpowers resume checkpoint" }]);
  });
});

function review(reviewNumber: number) {
  return { specCompliant: reviewNumber > 1, qualityApproved: reviewNumber > 1, findings: reviewNumber > 1 ? [] : ["Fix the failing check"] };
}

function done(): SubagentResult {
  return { status: "DONE", summary: "done", reportPath: "report.md", commit: "abc123", tests: ["npm test"] };
}

function checkpoint(phase: SuperpowersCheckpoint["phase"]): SuperpowersCheckpoint {
  return {
    version: 1,
    conversationId: "conversation-1",
    runId: "old-run",
    phase,
    skillNames: SKILLS,
    taskIndex: 0,
    updatedAt: 1,
  };
}

function runFrom(phase: SuperpowersCheckpoint["phase"], changes: Partial<SuperpowersCheckpoint> = {}) {
  return {
    runId: "run-1",
    task: "Implement safely",
    conversationId: "conversation-1",
    signal: new AbortController().signal,
    resumeState: { kind: "superpowers", checkpoint: { ...checkpoint(phase), ...changes } } as never,
  };
}

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "loopagent-supervisor-"));
}

function memoryStore(): WorkflowStore {
  const checkpoints = new Map<string, SuperpowersCheckpoint>();
  return {
    save(value) { checkpoints.set(value.conversationId, value); },
    load(conversationId) { return checkpoints.get(conversationId); },
    clear(conversationId) { checkpoints.delete(conversationId); },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function emptyCatalog() {
  return {
    list: () => [],
    async load(): Promise<never> { throw new Error("not used"); },
    async loadResource(): Promise<never> { throw new Error("not used"); },
  };
}

function invoke(tools: ReactAgentTool[], name: string, input: unknown): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return Promise.resolve(tool.invoke({ request: { id: "tool-1", name, rawArguments: JSON.stringify(input), input }, input, signal: new AbortController().signal }));
}
