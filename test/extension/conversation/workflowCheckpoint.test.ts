import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../../src/extension/conversation/conversationStore";
import {
  MAX_WORKFLOW_CHECKPOINT_BYTES,
  createPlanHash,
  sanitizeWorkflowCheckpoint,
  type WorkflowCheckpoint,
} from "../../../src/shared/workflowCheckpoint";

function makeCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    version: 1,
    conversationId: "conversation-1",
    runId: "run-1",
    planHash: "plan-1",
    revision: 1,
    status: "recovering",
    frontier: ["review"],
    executionOrder: ["prepare", "review"],
    nodes: {
      prepare: {
        nodeId: "prepare",
        status: "completed",
        inputHash: "input-prepare",
        attempts: 1,
        result: { status: "completed", content: "ready" },
        sideEffect: "none",
      },
      review: {
        nodeId: "review",
        status: "failed",
        inputHash: "input-review",
        attempts: 2,
        recoveryAttempts: 1,
        pendingRecovery: {
          action: "replace_node",
          targetNodeId: "review",
          reason: "repair timeout",
          task: "review repaired",
          timeoutMs: 60_000,
        },
        error: { code: "timeout", message: "timed out", retryable: true },
        sideEffect: "unknown",
      },
    },
    state: {
      step: 2,
      version: 1,
      values: { answer: "ready", nested: { count: 2 }, entries: { first: true } },
    },
    unresolvedFailures: [{
      nodeId: "review",
      code: "timeout",
      message: "timed out",
      attempt: 2,
      timeoutMs: 60_000,
      logs: [{ kind: "tool", name: "readFile", message: "permission denied" }],
    }],
    updatedAt: 100,
    ...overrides,
  };
}

describe("workflow checkpoint contract", () => {
  it("sanitizes JSON-safe state and round-trips it through the in-memory store", () => {
    const store = createConversationStore();
    const checkpoint = makeCheckpoint({
      state: {
        step: 2,
        version: 1,
        values: Object.fromEntries(new Map([["answer", "ready"], ["nested", { count: 2 }]])),
      },
    });

    expect(store.claimWorkflowCheckpoint(checkpoint.conversationId, checkpoint.runId, checkpoint.planHash, undefined)).toBe(true);
    expect(store.saveWorkflowCheckpoint(checkpoint)).toBe(true);
    expect(store.loadWorkflowCheckpoint(checkpoint.conversationId, checkpoint.runId)).toEqual(checkpoint);
  });

  it("creates the same plan hash regardless of object key order", () => {
    expect(createPlanHash({ nodes: [{ id: "a", task: "A" }], limits: { maxSteps: 5 } })).toBe(
      createPlanHash({ limits: { maxSteps: 5 }, nodes: [{ task: "A", id: "a" }] }),
    );
  });

  it("rejects unsupported versions, non-JSON values, and oversized payloads", () => {
    expect(() => sanitizeWorkflowCheckpoint(makeCheckpoint({ version: 2 as 1 }))).toThrow();
    expect(() => sanitizeWorkflowCheckpoint(makeCheckpoint({ state: { step: 2, version: 1, values: { bad: undefined } } }))).toThrow();
    expect(() => sanitizeWorkflowCheckpoint(makeCheckpoint({ state: { step: 2, version: 1, values: { text: "x".repeat(MAX_WORKFLOW_CHECKPOINT_BYTES) } } }))).toThrow();
  });

  it("accepts monotonic revisions but rejects stale revisions and stale runs", () => {
    const store = createConversationStore();
    const first = makeCheckpoint();
    const newer = makeCheckpoint({ revision: 2, updatedAt: 101 });
    const stale = makeCheckpoint({ revision: 1, updatedAt: 102 });
    const otherRun = makeCheckpoint({ runId: "run-2", revision: 1 });
    const otherPlan = makeCheckpoint({ planHash: "plan-2", revision: 3 });

    expect(store.claimWorkflowCheckpoint(first.conversationId, first.runId, first.planHash, undefined)).toBe(true);
    expect(store.saveWorkflowCheckpoint(first)).toBe(true);
    expect(store.getWorkflowCheckpointRunId(first.conversationId)).toBe(first.runId);
    expect(store.saveWorkflowCheckpoint(newer)).toBe(true);
    expect(store.saveWorkflowCheckpoint(stale)).toBe(false);
    expect(store.saveWorkflowCheckpoint(otherRun)).toBe(false);
    expect(store.saveWorkflowCheckpoint(otherPlan)).toBe(false);
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toEqual(newer);

    store.clearWorkflowCheckpoint(first.conversationId, "run-2");
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toEqual(newer);
    store.clearWorkflowCheckpoint(first.conversationId, first.runId);
    expect(store.getWorkflowCheckpointRunId(first.conversationId)).toBe(first.runId);
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toBeUndefined();
    expect(store.claimWorkflowCheckpoint(otherRun.conversationId, otherRun.runId, otherRun.planHash, first.runId)).toBe(true);
    expect(store.saveWorkflowCheckpoint(otherRun)).toBe(true);
  });

  it("atomically changes checkpoint ownership and rejects late writes from the old run", () => {
    const store = createConversationStore();
    const first = makeCheckpoint();
    const late = makeCheckpoint({ revision: 2, updatedAt: 101 });
    const next = makeCheckpoint({ runId: "run-2", planHash: "plan-2" });

    expect(store.saveWorkflowCheckpoint(first)).toBe(false);
    expect(store.claimWorkflowCheckpoint(first.conversationId, first.runId, first.planHash, undefined)).toBe(true);
    expect(store.saveWorkflowCheckpoint(first)).toBe(true);
    expect(store.claimWorkflowCheckpoint(next.conversationId, next.runId, next.planHash, first.runId)).toBe(true);
    expect(store.claimWorkflowCheckpoint(first.conversationId, first.runId, first.planHash, first.runId)).toBe(false);
    expect(store.saveWorkflowCheckpoint(late)).toBe(false);
    expect(store.getWorkflowCheckpointRunId(first.conversationId)).toBe(next.runId);
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toBeUndefined();
    expect(store.saveWorkflowCheckpoint(next)).toBe(true);
  });
});
