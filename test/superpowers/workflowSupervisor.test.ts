import { tmpdir } from "node:os";

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

  it("persists each approval gate and continues from its checkpoint", async () => {
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: { dispatch: async () => done(), cancelAll() {} },
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

    const firstRun = await collect(supervisor.run(request("run-1")));
    expect(firstRun.at(-1)).toEqual({
      type: "runInterrupted",
      runId: "run-1",
      conversationId: "conversation-2",
      task: "Add a small feature",
    });
    expect(store.load("conversation-2")).toMatchObject({ phase: "designApproval", waitingFor: "design approval", skillNames: SKILLS });

    const secondRun = await collect(supervisor.run(request("run-2", { kind: "superpowers", checkpoint: store.load("conversation-2") } as never)));
    expect(secondRun.at(-1)).toEqual({
      type: "runInterrupted",
      runId: "run-2",
      conversationId: "conversation-2",
      task: "Add a small feature",
    });
    expect(store.load("conversation-2")).toMatchObject({ phase: "specReview", waitingFor: "spec review" });

    await collect(supervisor.run(request("run-3", { kind: "superpowers", checkpoint: store.load("conversation-2") } as never)));
    expect(store.load("conversation-2")).toMatchObject({ phase: "planApproval", waitingFor: "plan approval" });
  });

  it("stops before a second agent when cancellation arrives after a dispatch", async () => {
    const controller = new AbortController();
    const roles: AgentRole[] = [];
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch(request) {
          roles.push(request.role);
          controller.abort();
          return done();
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
    expect(store.load("conversation-1")).toMatchObject({ phase: "blocked", activeAgentId: undefined, waitingFor: "cancelled" });
  });

  it("blocks before implementation when preflight detects a plan conflict", async () => {
    let dispatched = false;
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: { dispatch: async () => { dispatched = true; return done(); }, cancelAll() {} },
      workflowStore: store,
      model: "model",
      validatePlan: () => "plan conflicts with the current branch",
    });

    await collect(supervisor.run({
      runId: "run-1",
      task: "Implement safely",
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      resumeState: { kind: "superpowers", checkpoint: checkpoint("preflight") } as never,
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

  it("blocks with a clear plan error when the workspace plan is missing", async () => {
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({
      agentPool: { dispatch: async () => done(), cancelAll() {} },
      workflowStore: store,
      model: "model",
      workspaceRoot: "C:/path-that-does-not-exist",
      planPath: "docs/superpowers/plans/current-plan.md",
    });

    await collect(supervisor.run(runFrom("preflight")));

    expect(store.load("conversation-1")).toMatchObject({ phase: "blocked" });
    expect(store.load("conversation-1")?.waitingFor).toMatch(/plan|workspace|exist/i);
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

function runFrom(phase: SuperpowersCheckpoint["phase"]) {
  return {
    runId: "run-1",
    task: "Implement safely",
    conversationId: "conversation-1",
    signal: new AbortController().signal,
    resumeState: { kind: "superpowers", checkpoint: checkpoint(phase) } as never,
  };
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
