import { describe, expect, it } from "vitest";

import type { AgentPool, AgentRole, SubagentResult } from "../../src/extension/superpowers/agentPool";
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
    const pool: AgentPool = {
      async dispatch(request) {
        roles.push(request.role);
        return scriptedResult(request.role, roles.filter((role) => role === "taskReviewer").length);
      },
      cancelAll() {},
    };
    const store = memoryStore();
    const supervisor = createWorkflowSupervisor({ agentPool: pool, workflowStore: store, model: "model" });

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

    await collect(supervisor.run(request("run-1")));
    expect(store.load("conversation-2")).toMatchObject({ phase: "designApproval", waitingFor: "design approval", skillNames: SKILLS });

    await collect(supervisor.run(request("run-2", { kind: "superpowers", checkpoint: store.load("conversation-2") } as never)));
    expect(store.load("conversation-2")).toMatchObject({ phase: "specReview", waitingFor: "spec review" });

    await collect(supervisor.run(request("run-3", { kind: "superpowers", checkpoint: store.load("conversation-2") } as never)));
    expect(store.load("conversation-2")).toMatchObject({ phase: "planApproval", waitingFor: "plan approval" });
  });

  it("stops before a second agent when cancellation arrives after a dispatch", async () => {
    const controller = new AbortController();
    const roles: AgentRole[] = [];
    const supervisor = createWorkflowSupervisor({
      agentPool: {
        async dispatch(request) {
          roles.push(request.role);
          controller.abort();
          return done();
        },
        cancelAll() {},
      },
      workflowStore: memoryStore(),
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
    expect(messages).not.toContainEqual({ type: "runFinished", runId: "run-1" });
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
});

function scriptedResult(role: AgentRole, reviewNumber: number): SubagentResult {
  if (role === "taskReviewer" || role === "finalReviewer") {
    return { ...done(), specCompliant: reviewNumber > 1, qualityApproved: reviewNumber > 1, findings: reviewNumber > 1 ? [] : ["Fix the failing check"] } as SubagentResult;
  }
  return done();
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
