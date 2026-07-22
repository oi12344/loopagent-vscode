import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createPersistentConversationStore } from "../../src/extension/conversation/persistentConversationStore";
import { createWorkflowStore } from "../../src/extension/superpowers/workflowStore";
import type { SuperpowersCheckpoint } from "../../src/shared/chatTypes";

const directories: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openTempStore() {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-workflow-"));
  directories.push(directory);
  const databasePath = join(directory, "conversation.sqlite");
  const conversationStore = createPersistentConversationStore(databasePath);
  openStores.push(conversationStore);
  return { databasePath, workflowStore: createWorkflowStore(conversationStore) };
}

function checkpoint(conversationId = "conversation-1"): SuperpowersCheckpoint {
  return {
    version: 1,
    conversationId,
    runId: "run-1",
    phase: "review",
    skillNames: ["test-driven-development"],
    planPath: "docs/superpowers/plans/checkpoint.md",
    taskIndex: 2,
    activeAgentId: "agent-1",
    waitingFor: "review result",
    baseCommit: "abc123",
    updatedAt: 123,
  };
}

describe("WorkflowStore", () => {
  it("round-trips a review checkpoint and clears it", () => {
    const { databasePath, workflowStore } = openTempStore();
    const saved = checkpoint();

    workflowStore.save(saved);

    const reopenedConversationStore = createPersistentConversationStore(databasePath);
    openStores.push(reopenedConversationStore);
    const reopenedWorkflowStore = createWorkflowStore(reopenedConversationStore);
    expect(reopenedWorkflowStore.load(saved.conversationId)).toEqual(saved);
    reopenedWorkflowStore.clear(saved.conversationId);
    expect(reopenedWorkflowStore.load(saved.conversationId)).toBeUndefined();
  });

  it("throws when a persisted checkpoint is invalid instead of silently resetting it", () => {
    const { databasePath, workflowStore } = openTempStore();
    workflowStore.save(checkpoint());
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE superpowers_workflow SET checkpoint_json = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ ...checkpoint(), phase: "unknown" }), "conversation-1");
    database.close();

    expect(() => workflowStore.load("conversation-1")).toThrow(/invalid workflow checkpoint/i);
  });
});
