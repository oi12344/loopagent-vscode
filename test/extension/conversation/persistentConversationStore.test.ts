import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createPersistentConversationStore } from "../../../src/extension/conversation/persistentConversationStore";

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

  it("keeps only one active conversation: starting a new one replaces the old row", () => {
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
  });

  it("clearActiveConversation deletes the persisted row", () => {
    const { store, databasePath } = openTempStore();
    const context = store.createConversation();
    store.addMessage(context.conversationId, { role: "user", content: "Hello" });

    store.clearActiveConversation();
    expect(store.loadActiveConversation()).toBeUndefined();

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    expect(reopened.loadActiveConversation()).toBeUndefined();
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
      )
    `);
    raw.prepare(
      "INSERT INTO conversation (conversation_id, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("corrupt-conv", "{not valid json", Date.now(), Date.now());
    raw.close();

    const store = createPersistentConversationStore(databasePath);
    openStores.push(store);

    expect(store.loadActiveConversation()).toBeUndefined();
  });
});
