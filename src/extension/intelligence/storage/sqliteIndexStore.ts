import type { DatabaseSync } from "node:sqlite";

import type { IndexJobEvent, IndexJobStatus } from "./indexTypes";

export type IndexChange = {
  fileUri: string;
  eventKind: IndexJobEvent;
};

export type ClaimedIndexJob = {
  id: number;
  fileUri: string;
  eventKind: IndexJobEvent;
  claimedAt: number;
};

export type StoredIndexJob = {
  id: number;
  fileUri: string;
  eventKind: IndexJobEvent;
  status: IndexJobStatus;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

type JobRow = {
  id: number;
  file_uri: string;
  event_kind: IndexJobEvent;
  status: IndexJobStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

const WRITER_OWNER_KEY = "writer_owner";
const WRITER_LEASE_EXPIRES_AT_KEY = "writer_lease_expires_at";

export class SqliteIndexStore {
  private readonly now: () => number;

  constructor(
    private readonly database: DatabaseSync,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  enqueueFileEvent(ownerId: string, fileUri: string, eventKind: IndexJobEvent): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      this.upsertFileEvent(fileUri, eventKind);
    });
  }

  acquireWriterLease(ownerId: string, ttlMs: number): boolean {
    this.validateLeaseInput(ownerId, ttlMs);
    return this.transaction(() => {
      const now = this.now();
      const lease = this.readWriterLease();
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
        return false;
      }
      this.writeMeta(WRITER_OWNER_KEY, ownerId);
      this.writeMeta(WRITER_LEASE_EXPIRES_AT_KEY, String(now + ttlMs));
      return true;
    });
  }

  renewWriterLease(ownerId: string, ttlMs: number): boolean {
    this.validateLeaseInput(ownerId, ttlMs);
    return this.transaction(() => {
      const now = this.now();
      const lease = this.readWriterLease();
      if (!lease || lease.ownerId !== ownerId || lease.expiresAt <= now) {
        return false;
      }
      this.writeMeta(WRITER_LEASE_EXPIRES_AT_KEY, String(now + ttlMs));
      return true;
    });
  }

  releaseWriterLease(ownerId: string): void {
    if (!ownerId) return;
    this.transaction(() => {
      if (this.readWriterLease()?.ownerId !== ownerId) return;
      this.database.prepare("DELETE FROM index_meta WHERE key IN (?, ?)")
        .run(WRITER_OWNER_KEY, WRITER_LEASE_EXPIRES_AT_KEY);
    });
  }

  assertWriterLease(ownerId: string): void {
    const lease = this.readWriterLease();
    if (!lease || lease.ownerId !== ownerId || lease.expiresAt <= this.now()) {
      throw new Error(`Writer lease is not held by ${ownerId}`);
    }
  }

  enqueueChanges(ownerId: string, changes: readonly IndexChange[]): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      for (const change of changes) this.upsertFileEvent(change.fileUri, change.eventKind);
    });
  }

  private upsertFileEvent(fileUri: string, eventKind: IndexJobEvent): void {
    const now = this.now();
    this.database.prepare(`
      INSERT INTO index_jobs(file_uri, event_kind, status, attempts, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(file_uri) DO UPDATE SET
        event_kind = excluded.event_kind,
        status = 'pending',
        last_error = NULL,
        updated_at = max(excluded.updated_at, index_jobs.updated_at + 1)
    `).run(fileUri, eventKind, now, now);
  }

  claimNextJob(ownerId: string): ClaimedIndexJob | undefined {
    return this.transaction(() => {
      this.assertWriterLease(ownerId);
      const row = this.database.prepare(`
        SELECT id, file_uri, event_kind, updated_at
        FROM index_jobs
        WHERE status = 'pending'
        ORDER BY updated_at, id
        LIMIT 1
      `).get() as Pick<JobRow, "id" | "file_uri" | "event_kind" | "updated_at"> | undefined;
      if (!row) return undefined;

      const claimedAt = Math.max(this.now(), row.updated_at + 1);
      const result = this.database.prepare(`
        UPDATE index_jobs
        SET status = 'running', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(claimedAt, row.id);
      if (result.changes !== 1) return undefined;
      return { id: row.id, fileUri: row.file_uri, eventKind: row.event_kind, claimedAt };
    });
  }

  completeJob(ownerId: string, claim: ClaimedIndexJob): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      this.database.prepare(`
        DELETE FROM index_jobs WHERE id = ? AND status = 'running' AND updated_at = ?
      `).run(claim.id, claim.claimedAt);
    });
  }

  failJob(ownerId: string, claim: ClaimedIndexJob, error: string): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      this.database.prepare(`
        UPDATE index_jobs SET status = 'failed', last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND updated_at = ?
      `).run(error, this.now(), claim.id, claim.claimedAt);
    });
  }

  recoverInterruptedJobs(ownerId: string, { staleAfterMs }: { staleAfterMs: number }): number {
    return this.transaction(() => {
      this.assertWriterLease(ownerId);
      const now = this.now();
      const result = this.database.prepare(`
        UPDATE index_jobs SET status = 'pending', last_error = NULL, updated_at = ?
        WHERE status = 'running' AND updated_at <= ?
      `).run(now, now - staleAfterMs);
      return Number(result.changes);
    });
  }

  listPendingJobs(): StoredIndexJob[] {
    return this.readJobs("WHERE status = 'pending'");
  }

  listJobs(): StoredIndexJob[] {
    return this.readJobs("");
  }

  private readJobs(whereClause: string): StoredIndexJob[] {
    const rows = this.database.prepare(`
      SELECT id, file_uri, event_kind, status, attempts, last_error, created_at, updated_at
      FROM index_jobs ${whereClause} ORDER BY created_at, id
    `).all() as JobRow[];
    return rows.map((row) => ({
      id: row.id,
      fileUri: row.file_uri,
      eventKind: row.event_kind,
      status: row.status,
      attempts: row.attempts,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private readWriterLease(): { ownerId: string; expiresAt: number } | undefined {
    const rows = this.database.prepare("SELECT key, value FROM index_meta WHERE key IN (?, ?)")
      .all(WRITER_OWNER_KEY, WRITER_LEASE_EXPIRES_AT_KEY) as Array<{ key: string; value: string }>;
    if (rows.length === 0) return undefined;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const ownerId = values.get(WRITER_OWNER_KEY);
    const expiresAt = Number(values.get(WRITER_LEASE_EXPIRES_AT_KEY));
    if (!ownerId || !values.has(WRITER_LEASE_EXPIRES_AT_KEY) || !Number.isFinite(expiresAt)) {
      throw new Error("Corrupt writer lease metadata");
    }
    return { ownerId, expiresAt };
  }

  private writeMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO index_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private validateLeaseInput(ownerId: string, ttlMs: number): void {
    if (!ownerId) throw new Error("Writer lease owner ID is required");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Writer lease TTL must be positive");
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
