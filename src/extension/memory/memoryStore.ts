import { DatabaseSync } from "node:sqlite";

import type { MemoryEvidence, MemoryItem, MemoryKind, WriteResult } from "./types";

const LESSON_DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_ITEMS_PER_WORKSPACE = 200;

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

function rowToItem(row: MemoryItemRow): MemoryItem {
  return {
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
  };
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
      this.writeItemInternal(workspaceKey, item, now);
      this.cleanupExpiredAndOverCap(workspaceKey, now);
    });
  }

  /**
   * Low-level insert primitive: creates an item (default status 'active') without a lease
   * or generation check. `remember()` is built on top of this inside a guarded transaction;
   * it is also exposed directly so callers that already hold their own transaction/lease
   * discipline (e.g. a future automatic-capture writer) can insert without re-deriving the
   * insert + FTS-sync logic.
   */
  writeItem(
    workspaceKey: string,
    item: {
      kind: MemoryKind;
      subject: string;
      content: string;
      confidence: string;
      evidence: MemoryEvidence[];
      status?: string;
      expiresAt?: number;
    },
  ): number {
    return this.transaction(() => {
      this.ensureMetaRow(workspaceKey);
      const now = this.now();
      const id = this.writeItemInternal(workspaceKey, item, now);
      this.cleanupExpiredAndOverCap(workspaceKey, now);
      return id;
    });
  }

  /**
   * Re-checks freshness result for a batch of items and, only if `ownerId` currently holds
   * the writer lease, transitions them to 'stale' in a single transaction. Read-only instances
   * (no lease) are a no-op: the caller still excludes the items from the rendered prompt, but
   * status is left for whichever instance next holds the lease to persist.
   */
  markStale(workspaceKey: string, ownerId: string, ids: number[]): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      const lease = this.readLease(workspaceKey);
      if (!lease || lease.ownerId !== ownerId || lease.expiresAt <= this.now()) return;
      const now = this.now();
      const placeholders = ids.map(() => "?").join(",");
      this.database
        .prepare(`UPDATE memory_items SET status = 'stale', updated_at = ? WHERE workspace_key = ? AND id IN (${placeholders})`)
        .run(now, workspaceKey, ...ids);
    });
  }

  /**
   * Bounded FTS candidate search: active, non-expired items whose subject/content match the
   * (already-escaped) MATCH query, ordered by FTS relevance (bm25) then recency. The query
   * text itself must already be built from safe literal tokens by the caller -- FTS5 parses
   * the MATCH argument as a query-language string regardless of parameter binding.
   */
  search(workspaceKey: string, matchQuery: string, limit: number): MemoryItem[] {
    const now = this.now();
    // ponytail: bm25 + recency is a deliberate v1 stand-in for the design doc's full
    // "exact-term hits, evidence tier, source-hash freshness, recency" ranking -- evidence
    // tier and hash-freshness only affect the caller's pass/fail exclusion pass, not order.
    // Upgrade path if this proves too coarse: add a secondary ORDER BY key computed from
    // evidence count/kind (e.g. `json_array_length(evidence_json) DESC`) before updated_at.
    const rows = this.database
      .prepare(`
        SELECT mi.* FROM memory_fts f
        JOIN memory_items mi ON mi.id = f.memory_item_id
        WHERE mi.workspace_key = ? AND mi.status = 'active' AND (mi.expires_at IS NULL OR mi.expires_at > ?)
          AND memory_fts MATCH ?
        ORDER BY bm25(memory_fts), mi.updated_at DESC
        LIMIT ?
      `)
      .all(workspaceKey, now, matchQuery, limit) as unknown as MemoryItemRow[];
    return rows.map(rowToItem);
  }

  private writeItemInternal(
    workspaceKey: string,
    item: {
      kind: MemoryKind;
      subject: string;
      content: string;
      confidence: string;
      evidence: MemoryEvidence[];
      status?: string;
      expiresAt?: number;
    },
    now: number,
  ): number {
    const status = item.status ?? "active";
    const expiresAt = item.expiresAt ?? (item.kind === "lesson" ? now + LESSON_DEFAULT_TTL_MS : undefined);
    const evidenceJson = JSON.stringify(item.evidence);
    const result = this.database
      .prepare(`
        INSERT INTO memory_items(workspace_key, kind, subject, content, status, confidence, evidence_json, created_at, updated_at, expires_at, supersedes_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(workspaceKey, item.kind, item.subject, item.content, status, item.confidence, evidenceJson, now, now, expiresAt ?? null);
    const memoryItemId = Number(result.lastInsertRowid);
    this.database
      .prepare("INSERT INTO memory_fts(subject, content, memory_item_id) VALUES (?, ?, ?)")
      .run(item.subject, item.content, memoryItemId);
    return memoryItemId;
  }

  /**
   * ponytail: piggybacks retention cleanup on every write transaction instead of running a
   * background sweeper -- there is no case where memory changes without a write happening.
   * Removes items past their expires_at, then trims the oldest items beyond the per-workspace
   * cap. Runs inside the caller's existing transaction.
   */
  private cleanupExpiredAndOverCap(workspaceKey: string, now: number): void {
    const expiredIds = (
      this.database
        .prepare("SELECT id FROM memory_items WHERE workspace_key = ? AND expires_at IS NOT NULL AND expires_at <= ?")
        .all(workspaceKey, now) as unknown as { id: number }[]
    ).map((row) => row.id);
    this.deleteItems(expiredIds);

    const overCapIds = (
      this.database
        .prepare(`
          SELECT id FROM memory_items WHERE workspace_key = ?
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        `)
        .all(workspaceKey, MAX_ACTIVE_ITEMS_PER_WORKSPACE) as unknown as { id: number }[]
    ).map((row) => row.id);
    this.deleteItems(overCapIds);
  }

  private deleteItems(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.database.prepare(`DELETE FROM memory_fts WHERE memory_item_id IN (${placeholders})`).run(...ids);
    this.database.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(...ids);
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
      .prepare("SELECT * FROM memory_items WHERE workspace_key = ? AND status IN ('active', 'stale') ORDER BY created_at, id")
      .all(workspaceKey) as unknown as MemoryItemRow[];
    return rows.map(rowToItem);
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
