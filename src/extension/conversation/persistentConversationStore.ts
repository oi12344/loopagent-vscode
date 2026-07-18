import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ChatMessage, ConversationContext } from "../../shared/chatTypes";
import type { ConversationStore } from "./conversationStore";

type ConversationRow = {
  conversation_id: string;
  messages_json: string;
  created_at: number;
  updated_at: number;
};

/**
 * ConversationStore 的 SQLite 持久化实现。
 * 表里最多一行，代表"当前活跃对话"——见
 * docs/superpowers/specs/2026-07-19-conversation-persistence-design.md
 * 的"单行表，不做消息级关系表"。
 */
export function createPersistentConversationStore(
  databasePath: string,
): ConversationStore & { close(): void } {
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
  );
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation (
      conversation_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  let active: ConversationContext | undefined = loadFromDatabase();

  function loadFromDatabase(): ConversationContext | undefined {
    const row = database
      .prepare("SELECT conversation_id, messages_json, created_at, updated_at FROM conversation LIMIT 1")
      .get() as ConversationRow | undefined;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      messages: JSON.parse(row.messages_json) as ChatMessage[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function persist(context: ConversationContext): void {
    database.exec("DELETE FROM conversation");
    database
      .prepare(
        "INSERT INTO conversation (conversation_id, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(context.conversationId, JSON.stringify(context.messages), context.createdAt, context.updatedAt);
  }

  return {
    createConversation(): ConversationContext {
      const context: ConversationContext = {
        conversationId: generateConversationId(),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      active = context;
      persist(context);
      return context;
    },

    getConversation(conversationId: string): ConversationContext | undefined {
      return active?.conversationId === conversationId ? active : undefined;
    },

    addMessage(conversationId: string, message: ChatMessage): void {
      if (active?.conversationId !== conversationId) return;
      active.messages.push(message);
      active.updatedAt = Date.now();
      persist(active);
    },

    getMessages(conversationId: string): ChatMessage[] {
      return active?.conversationId === conversationId ? active.messages : [];
    },

    loadActiveConversation(): ConversationContext | undefined {
      return active;
    },

    clearActiveConversation(): void {
      active = undefined;
      database.exec("DELETE FROM conversation");
    },

    close(): void {
      database.close();
    },
  };
}
