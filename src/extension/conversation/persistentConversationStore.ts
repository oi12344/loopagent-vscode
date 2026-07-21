import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ChatMessage, ConversationContext, ConversationSummary } from "../../shared/chatTypes";
import type { ConversationStore } from "./conversationStore";

type ConversationRow = {
  conversation_id: string;
  messages_json: string;
  created_at: number;
  updated_at: number;
};

/**
 * ConversationStore 的 SQLite 持久化实现。
 * `conversation` 表按 conversation_id 保留每个对话的完整历史（多行）；
 * `active_conversation` 是单行表，只存"当前活跃对话"的指针——见
 * docs/superpowers/specs/2026-07-19-conversation-persistence-design.md。
 * 没有内存缓存：每次读写都直接打 SQLite，本地库足够快，省掉缓存失效的坑。
 */
export function createPersistentConversationStore(
  databasePath: string,
): ConversationStore & { close(): void } {
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
  );
  const hadActiveConversationTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'active_conversation'")
    .get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation (
      conversation_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_conversation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      conversation_id TEXT NOT NULL
    );
  `);

  function readContext(conversationId: string): ConversationContext | undefined {
    const row = database
      .prepare("SELECT conversation_id, messages_json, created_at, updated_at FROM conversation WHERE conversation_id = ?")
      .get(conversationId) as ConversationRow | undefined;
    if (!row) return undefined;
    try {
      return {
        conversationId: row.conversation_id,
        messages: JSON.parse(row.messages_json) as ChatMessage[],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return undefined;
    }
  }

  function readActiveConversationId(): string | undefined {
    const row = database.prepare("SELECT conversation_id FROM active_conversation WHERE id = 1").get() as
      | { conversation_id: string }
      | undefined;
    return row?.conversation_id;
  }

  function writeActiveConversationId(conversationId: string | undefined): void {
    if (conversationId === undefined) {
      database.exec("DELETE FROM active_conversation");
      return;
    }
    database
      .prepare(
        "INSERT INTO active_conversation (id, conversation_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id",
      )
      .run(conversationId);
  }

  function persist(context: ConversationContext): void {
    database
      .prepare(
        `INSERT INTO conversation (conversation_id, messages_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET messages_json = excluded.messages_json, updated_at = excluded.updated_at`,
      )
      .run(context.conversationId, JSON.stringify(context.messages), context.createdAt, context.updatedAt);
  }

  function generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  if (!hadActiveConversationTable) {
    const legacy = database
      .prepare("SELECT conversation_id FROM conversation ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get() as { conversation_id: string } | undefined;
    if (legacy) writeActiveConversationId(legacy.conversation_id);
  }

  return {
    createConversation(): ConversationContext {
      const context: ConversationContext = {
        conversationId: generateConversationId(),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      persist(context);
      writeActiveConversationId(context.conversationId);
      return context;
    },

    getConversation(conversationId: string): ConversationContext | undefined {
      return readContext(conversationId);
    },

    addMessage(conversationId: string, message: ChatMessage): void {
      const context = readContext(conversationId);
      if (!context) return;
      context.messages.push(message);
      context.updatedAt = Date.now();
      persist(context);
    },

    getMessages(conversationId: string): ChatMessage[] {
      return readContext(conversationId)?.messages ?? [];
    },

    loadActiveConversation(): ConversationContext | undefined {
      const activeId = readActiveConversationId();
      return activeId ? readContext(activeId) : undefined;
    },

    setActiveConversation(conversationId: string): ConversationContext | undefined {
      const context = readContext(conversationId);
      if (!context) return undefined;
      writeActiveConversationId(conversationId);
      return context;
    },

    clearActiveConversation(): void {
      writeActiveConversationId(undefined);
    },

    listConversations(): ConversationSummary[] {
      const rows = database
        .prepare("SELECT conversation_id, messages_json, updated_at FROM conversation ORDER BY updated_at DESC, rowid DESC")
        .all() as Array<{ conversation_id: string; messages_json: string; updated_at: number }>;

      return rows.map((row) => {
        let preview = "";
        try {
          const messages = JSON.parse(row.messages_json) as ChatMessage[];
          preview = messages.find((message) => message.role === "user")?.content.slice(0, 60) ?? "";
        } catch {
          // 单行损坏不影响列表其它项，预览留空即可
        }
        return { conversationId: row.conversation_id, updatedAt: row.updated_at, preview };
      });
    },

    close(): void {
      database.close();
    },
  };
}
