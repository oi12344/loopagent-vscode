import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ChatMessage,
  ConversationContext,
  ConversationSummary,
  InterruptedRunCheckpoint,
} from "../../shared/chatTypes";
import { sanitizeWorkflowCheckpoint, type WorkflowCheckpoint } from "../../shared/workflowCheckpoint";
import type { ConversationStore } from "./conversationStore";

type ConversationRow = {
  conversation_id: string;
  messages_json: string;
  created_at: number;
  updated_at: number;
};

type WorkflowCheckpointRow = {
  conversation_id: string;
  run_id: string;
  plan_hash: string;
  revision: number;
  status: string;
  checkpoint_json: string;
  updated_at: number;
};

type WorkflowCheckpointOwnerRow = {
  run_id: string;
  plan_hash: string;
  terminal: number;
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
  // 先尝试创建表。对于已有的数据库，CREATE TABLE IF NOT EXISTS 不做任何操作
  const conversationTableExists = (
    database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation'").get() as
      | { name: string }
      | undefined
  ) !== undefined;
  const activeConversationTableExists = (
    database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='active_conversation'").get() as
      | { name: string }
      | undefined
  ) !== undefined;
  const hadActiveConversationTable = activeConversationTableExists;

  if (conversationTableExists && !activeConversationTableExists) {
    // 旧数据库格式：只有 conversation 表，需要迁移
    database.exec(`
      CREATE TABLE active_conversation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        conversation_id TEXT NOT NULL
      );
    `);
    // 迁移策略：把最新的对话设为活跃
    const latestRow = database
      .prepare("SELECT conversation_id FROM conversation ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get() as { conversation_id: string } | undefined;
    if (latestRow) {
      database
        .prepare("INSERT INTO active_conversation (id, conversation_id) VALUES (1, ?)")
        .run(latestRow.conversation_id);
    }
  } else {
    // 新数据库或已迁移的数据库，创建新表即可
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
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS interrupted_run (
      conversation_id TEXT PRIMARY KEY,
      checkpoint_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_checkpoint (
      conversation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_checkpoint_owner (
      conversation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO workflow_checkpoint_owner (conversation_id, run_id, plan_hash)
      SELECT conversation_id, run_id, plan_hash FROM workflow_checkpoint;
  `);
  const ownerColumns = database.prepare("PRAGMA table_info(workflow_checkpoint_owner)").all() as Array<{ name: string }>;
  if (!ownerColumns.some((column) => column.name === "terminal")) {
    database.exec("ALTER TABLE workflow_checkpoint_owner ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0");
  }

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

  function readInterruptedRun(conversationId: string): InterruptedRunCheckpoint | undefined {
    const row = database
      .prepare("SELECT checkpoint_json FROM interrupted_run WHERE conversation_id = ?")
      .get(conversationId) as { checkpoint_json: string } | undefined;
    if (!row) return undefined;
    try {
      const checkpoint = JSON.parse(row.checkpoint_json) as InterruptedRunCheckpoint;
      if (
        checkpoint.version !== 1 ||
        checkpoint.conversationId !== conversationId ||
        typeof checkpoint.runId !== "string" ||
        typeof checkpoint.task !== "string" ||
        typeof checkpoint.step !== "number" ||
        !Array.isArray(checkpoint.messages)
      ) {
        return undefined;
      }
      return checkpoint;
    } catch {
      return undefined;
    }
  }

  function readWorkflowCheckpoint(conversationId: string, runId: string): WorkflowCheckpoint | undefined {
    const owner = database
      .prepare("SELECT run_id, plan_hash, terminal FROM workflow_checkpoint_owner WHERE conversation_id = ?")
      .get(conversationId) as WorkflowCheckpointOwnerRow | undefined;
    if (!owner || owner.terminal !== 0 || owner.run_id !== runId) return undefined;
    const row = database
      .prepare(
        "SELECT conversation_id, run_id, plan_hash, revision, status, checkpoint_json, updated_at FROM workflow_checkpoint WHERE conversation_id = ?",
      )
      .get(conversationId) as WorkflowCheckpointRow | undefined;
    if (!row || row.run_id !== runId || row.plan_hash !== owner.plan_hash) return undefined;
    try {
      const checkpoint = sanitizeWorkflowCheckpoint(JSON.parse(row.checkpoint_json));
      if (
        checkpoint.conversationId !== row.conversation_id ||
        checkpoint.runId !== row.run_id ||
        checkpoint.planHash !== row.plan_hash ||
        checkpoint.revision !== row.revision ||
        checkpoint.status !== row.status ||
        checkpoint.updatedAt !== row.updated_at
      ) {
        return undefined;
      }
      return checkpoint;
    } catch {
      return undefined;
    }
  }

  function withImmediateTransaction<T>(operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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

    saveInterruptedRun(checkpoint: InterruptedRunCheckpoint): void {
      database
        .prepare(
          `INSERT INTO interrupted_run (conversation_id, checkpoint_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at`,
        )
        .run(checkpoint.conversationId, JSON.stringify(checkpoint), checkpoint.updatedAt);
    },

    loadInterruptedRun(conversationId: string): InterruptedRunCheckpoint | undefined {
      return readInterruptedRun(conversationId);
    },

    clearInterruptedRun(conversationId: string): void {
      database.prepare("DELETE FROM interrupted_run WHERE conversation_id = ?").run(conversationId);
    },

    claimWorkflowCheckpoint(conversationId, runId, planHash, expectedRunId, expectedRevision): boolean {
      return withImmediateTransaction(() => {
        const owner = database
          .prepare("SELECT run_id, plan_hash, terminal FROM workflow_checkpoint_owner WHERE conversation_id = ?")
          .get(conversationId) as WorkflowCheckpointOwnerRow | undefined;
        if (owner?.run_id !== expectedRunId) return false;

        if (expectedRevision !== undefined) {
          const checkpoint = database
            .prepare("SELECT run_id, plan_hash, revision FROM workflow_checkpoint WHERE conversation_id = ?")
            .get(conversationId) as Pick<WorkflowCheckpointRow, "run_id" | "plan_hash" | "revision"> | undefined;
          if (
            !checkpoint
            || checkpoint.run_id !== runId
            || checkpoint.plan_hash !== planHash
            || checkpoint.revision !== expectedRevision
          ) return false;
        }

        database
          .prepare(
          `INSERT INTO workflow_checkpoint_owner (conversation_id, run_id, plan_hash, terminal)
             VALUES (?, ?, ?, 0)
             ON CONFLICT(conversation_id) DO UPDATE SET run_id = excluded.run_id, plan_hash = excluded.plan_hash, terminal = 0`,
          )
          .run(conversationId, runId, planHash);
        if (expectedRevision === undefined) {
          database.prepare("DELETE FROM workflow_checkpoint WHERE conversation_id = ?").run(conversationId);
        }
        return true;
      });
    },

    saveWorkflowCheckpoint(checkpoint: WorkflowCheckpoint): boolean {
      const sanitized = sanitizeWorkflowCheckpoint(checkpoint);
      return withImmediateTransaction(() => {
        const owner = database
          .prepare("SELECT run_id, plan_hash, terminal FROM workflow_checkpoint_owner WHERE conversation_id = ?")
          .get(sanitized.conversationId) as WorkflowCheckpointOwnerRow | undefined;
        if (!owner || owner.terminal !== 0 || owner.run_id !== sanitized.runId || owner.plan_hash !== sanitized.planHash) return false;
        const existing = database
          .prepare("SELECT revision FROM workflow_checkpoint WHERE conversation_id = ?")
          .get(sanitized.conversationId) as { revision: number } | undefined;
        if (existing && sanitized.revision <= existing.revision) return false;

        database
          .prepare(
            `INSERT INTO workflow_checkpoint (conversation_id, run_id, plan_hash, revision, status, checkpoint_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
               run_id = excluded.run_id,
               plan_hash = excluded.plan_hash,
               revision = excluded.revision,
               status = excluded.status,
               checkpoint_json = excluded.checkpoint_json,
               updated_at = excluded.updated_at`,
          )
          .run(
            sanitized.conversationId,
            sanitized.runId,
            sanitized.planHash,
            sanitized.revision,
            sanitized.status,
            JSON.stringify(sanitized),
            sanitized.updatedAt,
          );
        return true;
      });
    },

    loadWorkflowCheckpoint(conversationId: string, runId: string): WorkflowCheckpoint | undefined {
      return readWorkflowCheckpoint(conversationId, runId);
    },

    getWorkflowCheckpointRunId(conversationId: string): string | undefined {
      const row = database.prepare("SELECT run_id FROM workflow_checkpoint_owner WHERE conversation_id = ?").get(conversationId) as { run_id: string } | undefined;
      return row?.run_id;
    },

    clearWorkflowCheckpoint(conversationId: string, runId: string): void {
      withImmediateTransaction(() => {
        const owner = database.prepare("SELECT run_id FROM workflow_checkpoint_owner WHERE conversation_id = ?").get(conversationId) as { run_id: string } | undefined;
        if (owner?.run_id !== runId) return;
        database.prepare("DELETE FROM workflow_checkpoint WHERE conversation_id = ?").run(conversationId);
        database.prepare("UPDATE workflow_checkpoint_owner SET terminal = 1 WHERE conversation_id = ?").run(conversationId);
        // Keep the owner row as a terminal fence so a late write cannot recreate a checkpoint.
      });
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
