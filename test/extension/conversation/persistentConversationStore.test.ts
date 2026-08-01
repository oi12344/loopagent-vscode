import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createPersistentConversationStore } from "../../../src/extension/conversation/persistentConversationStore";
import type { InterruptedRunCheckpoint } from "../../../src/shared/chatTypes";
import type { WorkflowCheckpoint } from "../../../src/shared/workflowCheckpoint";

const directories: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openTempStore() {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
  directories.push(directory);
  const databasePath = join(directory, "conversation.sqlite");
  const store = createPersistentConversationStore(databasePath);
  openStores.push(store);
  return { store, databasePath };
}

function makeWorkflowCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
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
        sideEffect: "none",
      },
    },
    state: { step: 2, version: 1, values: { answer: "ready" } },
    unresolvedFailures: [{ nodeId: "review", code: "timeout", message: "timed out" }],
    updatedAt: 100,
    ...overrides,
  };
}

describe("createPersistentConversationStore", () => {
  it("has nothing to restore on a fresh database", () => {
    const { store } = openTempStore();
    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("persists messages and reloads them after reopening the database", () => {
    const { store, databasePath } = openTempStore();
    const context = store.createConversation();
    store.addMessage(context.conversationId, { role: "user", content: "Hello" });
    store.addMessage(context.conversationId, { role: "assistant", content: "Hi there" });

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    const restored = reopened.loadActiveConversation();

    expect(restored?.conversationId).toBe(context.conversationId);
    expect(restored?.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("migrates a legacy single-row database to the active conversation pointer", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
    directories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE conversation (
        conversation_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO conversation (conversation_id, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("legacy-conv", JSON.stringify([{ role: "user", content: "Legacy question" }]), 1, 2);
    raw.close();

    const store = createPersistentConversationStore(databasePath);
    openStores.push(store);

    expect(store.loadActiveConversation()).toEqual({
      conversationId: "legacy-conv",
      messages: [{ role: "user", content: "Legacy question" }],
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it("starting a new conversation moves the active pointer but keeps the old one in history", () => {
    const { store, databasePath } = openTempStore();
    const first = store.createConversation();
    store.addMessage(first.conversationId, { role: "user", content: "First" });

    const second = store.createConversation();
    store.addMessage(second.conversationId, { role: "user", content: "Second" });

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    const restored = reopened.loadActiveConversation();

    expect(restored?.conversationId).toBe(second.conversationId);
    expect(restored?.messages).toEqual([{ role: "user", content: "Second" }]);
    expect(reopened.getConversation(first.conversationId)?.messages).toEqual([{ role: "user", content: "First" }]);
  });

  it("clearActiveConversation only clears the pointer, history rows survive", () => {
    const { store, databasePath } = openTempStore();
    const context = store.createConversation();
    store.addMessage(context.conversationId, { role: "user", content: "Hello" });

    store.clearActiveConversation();
    expect(store.loadActiveConversation()).toBeUndefined();
    expect(store.getConversation(context.conversationId)?.messages).toEqual([{ role: "user", content: "Hello" }]);

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    expect(reopened.loadActiveConversation()).toBeUndefined();
    expect(reopened.getConversation(context.conversationId)).toBeDefined();
  });

  it("listConversations returns every stored conversation, newest first, with a preview", () => {
    const { store } = openTempStore();
    const first = store.createConversation();
    store.addMessage(first.conversationId, { role: "user", content: "What is TypeScript?" });

    const second = store.createConversation();
    store.addMessage(second.conversationId, { role: "user", content: "And Rust?" });

    const summaries = store.listConversations();
    expect(summaries).toEqual([
      { conversationId: second.conversationId, updatedAt: expect.any(Number), preview: "And Rust?" },
      { conversationId: first.conversationId, updatedAt: expect.any(Number), preview: "What is TypeScript?" },
    ]);
  });

  it("setActiveConversation switches the pointer back to an older conversation", () => {
    const { store } = openTempStore();
    const first = store.createConversation();
    store.createConversation();

    const switched = store.setActiveConversation(first.conversationId);
    expect(switched?.conversationId).toBe(first.conversationId);
    expect(store.loadActiveConversation()?.conversationId).toBe(first.conversationId);
  });

  it("setActiveConversation returns undefined for an unknown id and leaves the pointer untouched", () => {
    const { store } = openTempStore();
    const first = store.createConversation();

    expect(store.setActiveConversation("nonexistent")).toBeUndefined();
    expect(store.loadActiveConversation()?.conversationId).toBe(first.conversationId);
  });

  it("ignores addMessage for an unknown conversationId, matching the in-memory store", () => {
    const { store } = openTempStore();
    store.addMessage("nonexistent", { role: "user", content: "orphan" });
    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("creates the parent directory if it does not exist yet", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
    directories.push(directory);
    const databasePath = join(directory, "nested", ".loopagent", "conversation.sqlite");

    const store = createPersistentConversationStore(databasePath);
    openStores.push(store);

    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("fails safe when the persisted messages_json is corrupted", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
    directories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");

    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE conversation (
        conversation_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE active_conversation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        conversation_id TEXT NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO conversation (conversation_id, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("corrupt-conv", "{not valid json", Date.now(), Date.now());
    raw.prepare("INSERT INTO active_conversation (id, conversation_id) VALUES (1, ?)").run("corrupt-conv");
    raw.close();

    const store = createPersistentConversationStore(databasePath);
    openStores.push(store);

    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("persists an interrupted run checkpoint across reopen", () => {
    const { store, databasePath } = openTempStore();
    const context = store.createConversation();
    const checkpoint: InterruptedRunCheckpoint = {
      version: 1,
      conversationId: context.conversationId,
      runId: "run-1",
      task: "Continue the task",
      step: 2,
      messages: [
        { role: "user", content: "Continue the task" },
        { role: "assistant", content: "", toolCalls: [] },
      ],
      updatedAt: 20,
    };

    store.saveInterruptedRun(checkpoint);
    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);

    expect(reopened.loadInterruptedRun(context.conversationId)).toEqual(checkpoint);
    reopened.clearInterruptedRun(context.conversationId);
    expect(reopened.loadInterruptedRun(context.conversationId)).toBeUndefined();
  });

  it("preserves an obsolete Superpowers table while ordinary checkpoints remain usable", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
    directories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE superpowers_workflow (
        conversation_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO superpowers_workflow (conversation_id, checkpoint_json, updated_at) VALUES (?, ?, ?)",
    ).run("legacy-conv", '{"phase":"finished"}', 10);
    raw.close();

    const store = createPersistentConversationStore(databasePath);
    const checkpoint: InterruptedRunCheckpoint = {
      version: 1,
      conversationId: "current-conv",
      runId: "run-current",
      task: "Continue current work",
      step: 1,
      messages: [],
      updatedAt: 20,
    };
    store.saveInterruptedRun(checkpoint);
    store.close();

    const reopenedRaw = new DatabaseSync(databasePath);
    expect(
      reopenedRaw.prepare("SELECT checkpoint_json FROM superpowers_workflow WHERE conversation_id = ?")
        .get("legacy-conv"),
    ).toEqual({ checkpoint_json: '{"phase":"finished"}' });
    reopenedRaw.close();

    const reopenedStore = createPersistentConversationStore(databasePath);
    openStores.push(reopenedStore);
    expect(reopenedStore.loadInterruptedRun("current-conv")).toEqual(checkpoint);
  });

  it("persists workflow checkpoints across close and reopen", () => {
    const { store, databasePath } = openTempStore();
    const checkpoint = makeWorkflowCheckpoint();

    expect(store.claimWorkflowCheckpoint(checkpoint.conversationId, checkpoint.runId, checkpoint.planHash, undefined)).toBe(true);
    expect(store.saveWorkflowCheckpoint(checkpoint)).toBe(true);
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    expect(reopened.loadWorkflowCheckpoint(checkpoint.conversationId, checkpoint.runId)).toEqual(checkpoint);
  });

  it("ignores stale revisions and late writes from an older run", () => {
    const { store } = openTempStore();
    const first = makeWorkflowCheckpoint();
    const newer = makeWorkflowCheckpoint({ revision: 2, updatedAt: 101 });
    const stale = makeWorkflowCheckpoint({ revision: 1, updatedAt: 102 });
    const otherRun = makeWorkflowCheckpoint({ runId: "run-2", revision: 3 });
    const otherPlan = makeWorkflowCheckpoint({ planHash: "plan-2", revision: 3 });

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
    expect(store.claimWorkflowCheckpoint(otherRun.conversationId, otherRun.runId, otherRun.planHash, first.runId)).toBe(true);
    expect(store.saveWorkflowCheckpoint(otherRun)).toBe(true);
  });

  it("keeps a terminal owner fence after completion", () => {
    const { store } = openTempStore();
    const completed = makeWorkflowCheckpoint();
    const late = makeWorkflowCheckpoint({ revision: 2, updatedAt: 101 });
    const next = makeWorkflowCheckpoint({ runId: "run-2", planHash: "plan-2" });

    expect(store.claimWorkflowCheckpoint(completed.conversationId, completed.runId, completed.planHash, undefined)).toBe(true);
    expect(store.saveWorkflowCheckpoint(completed)).toBe(true);
    store.clearWorkflowCheckpoint(completed.conversationId, completed.runId);

    expect(store.loadWorkflowCheckpoint(completed.conversationId, completed.runId)).toBeUndefined();
    expect(store.saveWorkflowCheckpoint(late)).toBe(false);
    expect(store.claimWorkflowCheckpoint(next.conversationId, next.runId, next.planHash, completed.runId)).toBe(true);
    expect(store.saveWorkflowCheckpoint(next)).toBe(true);
  });

  it("persists an atomic ownership claim before the first snapshot", () => {
    const { store } = openTempStore();
    const first = makeWorkflowCheckpoint();
    const late = makeWorkflowCheckpoint({ revision: 2, updatedAt: 101 });
    const next = makeWorkflowCheckpoint({ runId: "run-2", planHash: "plan-2" });

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

  it("fails safe when workflow checkpoint JSON is corrupted", () => {
    const { store, databasePath } = openTempStore();
    const checkpoint = makeWorkflowCheckpoint();
    expect(store.claimWorkflowCheckpoint(checkpoint.conversationId, checkpoint.runId, checkpoint.planHash, undefined)).toBe(true);
    expect(store.saveWorkflowCheckpoint(checkpoint)).toBe(true);
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE workflow_checkpoint SET checkpoint_json = ? WHERE conversation_id = ?").run("{bad", checkpoint.conversationId);
    raw.close();

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    expect(reopened.loadWorkflowCheckpoint(checkpoint.conversationId, checkpoint.runId)).toBeUndefined();
  });
});
