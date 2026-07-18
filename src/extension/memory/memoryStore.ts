import { DatabaseSync } from "node:sqlite";

import type { MemoryEvidence, MemoryItem, MemoryKind, WriteResult } from "./types";

export function openMemoryDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
  );
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta(
      workspace_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      writer_owner TEXT,
      writer_expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs(
      id INTEGER PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      task_summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      verified INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_items(
      id INTEGER PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      supersedes_id INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(subject, content, memory_item_id UNINDEXED);
  `);
  return database;
}

export function checkpointAndCloseMemoryDatabase(database: Pick<DatabaseSync, "exec" | "close">): void {
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

type MemoryItemRow = {
  id: number;
  kind: MemoryKind;
  subject: string;
  content: string;
  status: string;
  confidence: string;
  evidence_json: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  supersedes_id: number | null;
};

/**
 * Owns the V1 memory schema: lease acquisition/renewal, generation CAS, and the
 * FTS-synchronized remember/forget transactions. Deliberately not a generic SQLite
 * layer -- this table set is specific to project memory and stays that way.
 */
export class MemoryStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  acquireLease(workspaceKey: string, ownerId: string, ttlMs: number): boolean {
    return this.transaction(() => {
      this.ensureMetaRow(workspaceKey);
      const now = this.now();
      const lease = this.readLease(workspaceKey);
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) return false;
      this.database
        .prepare("UPDATE memory_meta SET writer_owner = ?, writer_expires_at = ?, updated_at = ? WHERE workspace_key = ?")
        .run(ownerId, now + ttlMs, now, workspaceKey);
      return true;
    });
  }

  renewLease(workspaceKey: string, ownerId: string, ttlMs: number): boolean {
    return this.transaction(() => {
      const now = this.now();
      const lease = this.readLease(workspaceKey);
      if (!lease || lease.ownerId !== ownerId || lease.expiresAt <= now) return false;
      this.database
        .prepare("UPDATE memory_meta SET writer_expires_at = ?, updated_at = ? WHERE workspace_key = ?")
        .run(now + ttlMs, now, workspaceKey);
      return true;
    });
  }

  releaseLease(workspaceKey: string, ownerId: string): void {
    this.transaction(() => {
      const lease = this.readLease(workspaceKey);
      if (!lease || lease.ownerId !== ownerId) return;
      this.database
        .prepare("UPDATE memory_meta SET writer_owner = NULL, writer_expires_at = NULL, updated_at = ? WHERE workspace_key = ?")
        .run(this.now(), workspaceKey);
    });
  }

  getGeneration(workspaceKey: string): number {
    return this.transaction(() => {
      this.ensureMetaRow(workspaceKey);
      return this.readGeneration(workspaceKey);
    });
  }

  remember(
    workspaceKey: string,
    ownerId: string,
    expectedGeneration: number,
    item: { kind: MemoryKind; subject: string; content: string; confidence: string; evidence: MemoryEvidence[]; expiresAt?: number },
  ): WriteResult {
    return this.guardedWrite(workspaceKey, ownerId, expectedGeneration, (now) => {
      const evidenceJson = JSON.stringify(item.evidence);
      const result = this.database
        .prepare(`
          INSERT INTO memory_items(workspace_key, kind, subject, content, status, confidence, evidence_json, created_at, updated_at, expires_at, supersedes_id)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)
        `)
        .run(workspaceKey, item.kind, item.subject, item.content, item.confidence, evidenceJson, now, now, item.expiresAt ?? null);
      const memoryItemId = Number(result.lastInsertRowid);
      this.database
        .prepare("INSERT INTO memory_fts(subject, content, memory_item_id) VALUES (?, ?, ?)")
        .run(item.subject, item.content, memoryItemId);
    });
  }

  forget(workspaceKey: string, ownerId: string, expectedGeneration: number): WriteResult {
    return this.guardedWrite(workspaceKey, ownerId, expectedGeneration, (now) => {
      this.database
        .prepare(`
          DELETE FROM memory_fts
          WHERE memory_item_id IN (SELECT id FROM memory_items WHERE workspace_key = ?)
        `)
        .run(workspaceKey);
      this.database.prepare("DELETE FROM memory_items WHERE workspace_key = ?").run(workspaceKey);
      this.database
        .prepare("UPDATE memory_meta SET generation = generation + 1, updated_at = ? WHERE workspace_key = ?")
        .run(now, workspaceKey);
    });
  }

  list(workspaceKey: string): MemoryItem[] {
    const rows = this.database
      .prepare("SELECT * FROM memory_items WHERE workspace_key = ? AND status = 'active' ORDER BY created_at, id")
      .all(workspaceKey) as unknown as MemoryItemRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      content: row.content,
      status: row.status,
      confidence: row.confidence,
      evidence: JSON.parse(row.evidence_json) as MemoryEvidence[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.supersedes_id === null ? {} : { supersedesId: row.supersedes_id }),
    }));
  }

  private guardedWrite(workspaceKey: string, ownerId: string, expectedGeneration: number, mutate: (now: number) => void): WriteResult {
    return this.transaction(() => {
      this.ensureMetaRow(workspaceKey);
      const now = this.now();
      const lease = this.readLease(workspaceKey);
      if (!lease || lease.ownerId !== ownerId || lease.expiresAt <= now) {
        return { ok: false, reason: "lease_lost" };
      }
      if (this.readGeneration(workspaceKey) !== expectedGeneration) {
        return { ok: false, reason: "generation_changed" };
      }
      mutate(now);
      return { ok: true };
    });
  }

  private ensureMetaRow(workspaceKey: string): void {
    this.database
      .prepare("INSERT INTO memory_meta(workspace_key, generation, updated_at) VALUES (?, 0, ?) ON CONFLICT(workspace_key) DO NOTHING")
      .run(workspaceKey, this.now());
  }

  private readGeneration(workspaceKey: string): number {
    const row = this.database.prepare("SELECT generation FROM memory_meta WHERE workspace_key = ?").get(workspaceKey) as
      | { generation: number }
      | undefined;
    return row?.generation ?? 0;
  }

  private readLease(workspaceKey: string): { ownerId: string; expiresAt: number } | undefined {
    const row = this.database
      .prepare("SELECT writer_owner, writer_expires_at FROM memory_meta WHERE workspace_key = ?")
      .get(workspaceKey) as { writer_owner: string | null; writer_expires_at: number | null } | undefined;
    if (!row || !row.writer_owner || row.writer_expires_at === null) return undefined;
    return { ownerId: row.writer_owner, expiresAt: row.writer_expires_at };
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
