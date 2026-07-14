import type { DatabaseSync } from "node:sqlite";

import type { ExtractionSnapshot, IndexJobEvent, IndexJobStatus } from "./indexTypes";

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

export type StoredFileMetadata = {
  uri: string;
  contentHash: string;
  byteLength: number;
  mtime: number;
  extractorVersion: number;
  chunkerVersion: number;
};

export type FileMetadataUpdate = Omit<StoredFileMetadata, "contentHash">;

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

  applyFileSnapshot(ownerId: string, snapshot: ExtractionSnapshot): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      const now = this.now();
      const existingChunks = new Map((this.database.prepare(
        "SELECT id, source_hash, search_hash, embedding_hash FROM chunks WHERE file_id = ?",
      ).all(snapshot.file.id) as Array<{ id: string; source_hash: string; search_hash: string; embedding_hash: string }>).map((row) => [row.id, row]));
      const incomingChunkIds = new Set(snapshot.chunks.map((chunk) => chunk.id));

      this.database.prepare("DELETE FROM edges WHERE file_id = ?").run(snapshot.file.id);
      this.database.prepare("DELETE FROM import_bindings WHERE file_id = ?").run(snapshot.file.id);
      this.database.prepare("DELETE FROM unresolved_references WHERE file_id = ?").run(snapshot.file.id);
      this.database.prepare("DELETE FROM diagnostics WHERE file_id = ?").run(snapshot.file.id);
      for (const chunkId of existingChunks.keys()) {
        if (!incomingChunkIds.has(chunkId)) {
          this.database.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").run(chunkId);
          this.database.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
        }
      }

      const incomingNodeIds = new Set(snapshot.nodes.map((node) => node.id));
      const storedNodeIds = this.database.prepare("SELECT id FROM nodes WHERE file_id = ?").all(snapshot.file.id) as Array<{ id: string }>;
      for (const { id } of storedNodeIds) {
        if (!incomingNodeIds.has(id)) this.database.prepare("DELETE FROM nodes WHERE id = ?").run(id);
      }

      this.database.prepare(`
        INSERT INTO files(id, path, uri, language_id, content_hash, byte_length, mtime, index_state, extractor_ver, chunker_ver, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'ready', 1, 1, ?)
        ON CONFLICT(id) DO UPDATE SET path = excluded.path, uri = excluded.uri, language_id = excluded.language_id,
          content_hash = excluded.content_hash, byte_length = excluded.byte_length, index_state = 'ready', indexed_at = excluded.indexed_at
      `).run(snapshot.file.id, snapshot.file.path, snapshot.file.uri, snapshot.file.languageId, snapshot.file.contentHash, snapshot.file.byteLength, now);
      const upsertNode = this.database.prepare(`
        INSERT INTO nodes(id, file_id, semantic_key, kind, name, qualified_name, start_line, end_line, start_column, end_column, signature, exported, content_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET start_line = excluded.start_line, end_line = excluded.end_line,
          start_column = excluded.start_column, end_column = excluded.end_column, signature = excluded.signature,
          exported = excluded.exported, metadata_json = excluded.metadata_json
      `);
      for (const node of snapshot.nodes) {
        upsertNode.run(node.id, node.fileId, node.semanticKey, node.kind, node.name, node.qualifiedName, node.startLine, node.endLine,
          node.startColumn ?? null, node.endColumn ?? null, node.signature ?? null, Number(Boolean(node.isExported)), node.semanticKey, JSON.stringify(node.metadata ?? {}));
      }

      const chunkByNodeId = new Map(snapshot.chunks.filter((chunk) => chunk.nodeId).map((chunk) => [chunk.nodeId!, chunk.id]));
      const fileChunkId = snapshot.chunks.find((chunk) => chunk.chunkKind === "file_card")?.id;
      const upsertChunk = this.database.prepare(`
        INSERT INTO chunks(id, file_id, node_id, semantic_key, chunk_kind, source_text, search_text, embedding_text, source_hash, search_hash, embedding_hash, start_line, end_line, token_hint, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, semantic_key = excluded.semantic_key, chunk_kind = excluded.chunk_kind,
          source_text = excluded.source_text, search_text = excluded.search_text, embedding_text = excluded.embedding_text,
          source_hash = excluded.source_hash, search_hash = excluded.search_hash, embedding_hash = excluded.embedding_hash,
          start_line = excluded.start_line, end_line = excluded.end_line, updated_at = excluded.updated_at
      `);
      for (const chunk of snapshot.chunks) {
        const existing = existingChunks.get(chunk.id);
        const unchanged = existing && existing.source_hash === chunk.sourceHash && existing.search_hash === chunk.searchHash && existing.embedding_hash === chunk.embeddingHash;
        if (unchanged) {
          this.database.prepare("UPDATE chunks SET node_id = ?, start_line = ?, end_line = ? WHERE id = ?")
            .run(chunk.nodeId ?? null, chunk.startLine ?? null, chunk.endLine ?? null, chunk.id);
        } else {
          upsertChunk.run(chunk.id, chunk.fileId, chunk.nodeId ?? null, chunk.semanticKey, chunk.chunkKind, chunk.sourceText, chunk.searchText,
            chunk.embeddingText, chunk.sourceHash, chunk.searchHash, chunk.embeddingHash, chunk.startLine ?? null, chunk.endLine ?? null, now);
        }
        if (!existing || existing.search_hash !== chunk.searchHash) {
          this.database.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").run(chunk.id);
          this.database.prepare("INSERT INTO chunk_fts(chunk_id, search_text) VALUES (?, ?)").run(chunk.id, chunk.searchText);
        }
      }

      const upsertEdge = this.database.prepare("INSERT INTO edges(id, source_node_id, target_node_id, owner_chunk_id, kind, file_id, line, confidence, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const edge of snapshot.edges) upsertEdge.run(edge.id, edge.sourceNodeId, edge.targetNodeId, chunkByNodeId.get(edge.sourceNodeId) ?? fileChunkId ?? null, edge.kind, edge.fileId, edge.line ?? null, edge.confidence, JSON.stringify(edge.metadata ?? {}));
      const upsertBinding = this.database.prepare("INSERT INTO import_bindings(id, file_id, owner_chunk_id, imported_name, local_name, module_specifier, resolved_file_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const binding of snapshot.importBindings) upsertBinding.run(binding.id, binding.fileId, fileChunkId ?? null, binding.importedName, binding.localName, binding.source, binding.resolvedFileId ?? null);
      const upsertReference = this.database.prepare("INSERT INTO unresolved_references(id, file_id, owner_chunk_id, reference_name, reference_kind, line, column, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const reference of snapshot.unresolvedReferences) upsertReference.run(reference.id, reference.fileId, chunkByNodeId.get(reference.fromNodeId) ?? fileChunkId ?? null, reference.referenceName, reference.referenceKind, reference.line, reference.column ?? null, JSON.stringify(reference.metadata ?? {}));
      const upsertDiagnostic = this.database.prepare("INSERT INTO diagnostics(id, file_id, owner_chunk_id, severity, code, message, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)");
      for (const diagnostic of snapshot.diagnostics) upsertDiagnostic.run(diagnostic.id, diagnostic.fileId, fileChunkId ?? null, diagnostic.severity, diagnostic.message, now);
    });
  }

  listIndexedFiles(): StoredFileMetadata[] {
    const rows = this.database.prepare(`
      SELECT uri, content_hash, byte_length, mtime, extractor_ver, chunker_ver
      FROM files WHERE index_state = 'ready' ORDER BY uri
    `).all() as Array<{
      uri: string;
      content_hash: string;
      byte_length: number;
      mtime: number;
      extractor_ver: number;
      chunker_ver: number;
    }>;
    return rows.map((row) => ({
      uri: row.uri,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
      mtime: row.mtime,
      extractorVersion: row.extractor_ver,
      chunkerVersion: row.chunker_ver,
    }));
  }

  updateFileMetadata(ownerId: string, update: FileMetadataUpdate): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      const result = this.database.prepare(`
        UPDATE files SET mtime = ?, byte_length = ?, extractor_ver = ?, chunker_ver = ?
        WHERE uri = ?
      `).run(update.mtime, update.byteLength, update.extractorVersion, update.chunkerVersion, update.uri);
      if (result.changes !== 1) throw new Error(`Indexed file not found: ${update.uri}`);
    });
  }

  removeFile(ownerId: string, fileUri: string): void {
    this.transaction(() => {
      this.assertWriterLease(ownerId);
      this.database.prepare(`
        DELETE FROM chunk_fts
        WHERE chunk_id IN (
          SELECT chunks.id FROM chunks
          JOIN files ON files.id = chunks.file_id
          WHERE files.uri = ?
        )
      `).run(fileUri);
      this.database.prepare("DELETE FROM files WHERE uri = ?").run(fileUri);
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
