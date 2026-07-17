import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openIndexDatabase } from "../../src/extension/intelligence/storage/indexDatabase";
import {
  applyIndexMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../../src/extension/intelligence/storage/indexMigrations";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-index-schema-"));
  temporaryDirectories.push(directory);
  return join(directory, "index.sqlite");
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function indexNames(database: DatabaseSync, table: string): string[] {
  return database.prepare(`PRAGMA index_list(${table})`).all().map((row) => String(row.name));
}

describe("SQLite index migrations", () => {
  it("creates the complete version 1 schema with required columns", () => {
    const database = new DatabaseSync(createDatabasePath());
    try {
      applyIndexMigrations(database);

      expect(tableNames(database)).toEqual(expect.arrayContaining([
        "chunk_embeddings", "chunk_fts", "chunks", "diagnostics", "edges",
        "embedding_cache", "file_dependencies", "files", "import_bindings",
        "index_jobs", "index_meta", "nodes", "schema_migrations",
        "unresolved_references",
      ]));
      expect(columnNames(database, "files")).toEqual([
        "id", "path", "uri", "language_id", "content_hash", "byte_length", "mtime",
        "index_state", "extractor_ver", "chunker_ver", "indexed_at",
      ]);
      expect(columnNames(database, "chunks")).toEqual([
        "id", "file_id", "node_id", "semantic_key", "chunk_kind", "source_text",
        "search_text", "embedding_text", "source_hash", "search_hash",
        "embedding_hash", "start_line", "end_line", "token_hint", "updated_at",
      ]);
      expect(columnNames(database, "index_jobs")).toEqual([
        "id", "file_uri", "event_kind", "status", "attempts", "last_error",
        "created_at", "updated_at",
      ]);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(CURRENT_INDEX_SCHEMA_VERSION).toBe(2);
    } finally {
      database.close();
    }
  });

  it("creates foreign keys with the required delete actions and queue/search indexes", () => {
    const database = new DatabaseSync(createDatabasePath());
    try {
      applyIndexMigrations(database);
      const chunkForeignKeys = database.prepare("PRAGMA foreign_key_list(chunks)").all();
      expect(chunkForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "file_id", table: "files", on_delete: "CASCADE" }),
        expect.objectContaining({ from: "node_id", table: "nodes", on_delete: "SET NULL" }),
      ]));
      expect(indexNames(database, "nodes")).toEqual(expect.arrayContaining([
        "idx_nodes_file_id", "idx_nodes_name", "idx_nodes_qualified_name",
      ]));
      expect(indexNames(database, "edges")).toEqual(expect.arrayContaining([
        "idx_edges_source_node_id", "idx_edges_target_node_id", "idx_edges_owner_chunk_id",
      ]));
      expect(indexNames(database, "chunks")).toEqual(expect.arrayContaining([
        "idx_chunks_file_id", "idx_chunks_node_id", "idx_chunks_embedding_hash",
      ]));
      expect(indexNames(database, "index_jobs")).toContain("idx_index_jobs_status_updated_at");
      expect(indexNames(database, "chunk_embeddings")).toContain("idx_chunk_embeddings_status_updated_at");
    } finally {
      database.close();
    }
  });

  it("is idempotent and rejects a newer schema", () => {
    const database = new DatabaseSync(createDatabasePath());
    try {
      applyIndexMigrations(database);
      applyIndexMigrations(database);
      database.exec("PRAGMA user_version = 999");
      expect(() => applyIndexMigrations(database)).toThrow(/newer schema version/i);
    } finally {
      database.close();
    }
  });

  it("backs up an incompatible database before rebuilding", () => {
    const databasePath = createDatabasePath();
    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec("CREATE TABLE old_data(value TEXT); PRAGMA user_version = 999;");
    incompatible.close();

    const result = openIndexDatabase(databasePath, { now: () => 12345 });
    try {
      expect(result.backupPath).toBe(`${databasePath}.backup-12345`);
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      result.close();
    }
  });
});
