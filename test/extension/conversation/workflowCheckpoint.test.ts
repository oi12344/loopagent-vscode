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
        error: { code: "timeout", message: "timed out", retryable: true },
        sideEffect: "unknown",
      },
    },
    state: {
      step: 2,
      version: 1,
      values: { answer: "ready", nested: { count: 2 }, entries: { first: true } },
    },
    unresolvedFailures: [{ nodeId: "review", code: "timeout", message: "timed out" }],
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

    expect(store.saveWorkflowCheckpoint(first)).toBe(true);
    expect(store.saveWorkflowCheckpoint(newer)).toBe(true);
    expect(store.saveWorkflowCheckpoint(stale)).toBe(false);
    expect(store.saveWorkflowCheckpoint(otherRun)).toBe(false);
    expect(store.saveWorkflowCheckpoint(otherPlan)).toBe(false);
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toEqual(newer);

    store.clearWorkflowCheckpoint(first.conversationId, "run-2");
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toEqual(newer);
    store.clearWorkflowCheckpoint(first.conversationId, first.runId);
    expect(store.loadWorkflowCheckpoint(first.conversationId, first.runId)).toBeUndefined();
    expect(store.saveWorkflowCheckpoint(otherRun)).toBe(true);
  });
});
