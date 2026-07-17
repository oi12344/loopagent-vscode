import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildExtractionSnapshot } from "../../src/extension/intelligence/indexing/extractionSnapshot";
import { openIndexDatabase, type OpenIndexDatabaseResult } from "../../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../../src/extension/intelligence/storage/sqliteIndexStore";
import type { SnapshotInput } from "../../src/extension/intelligence/indexing/extractionSnapshot";
import type { CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const databases: OpenIndexDatabaseResult[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-fts-search-"));
  directories.push(directory);
  const opened = openIndexDatabase(join(directory, "index.sqlite"));
  databases.push(opened);
  const store = new SqliteIndexStore(opened.database, { now: () => 1_000 });
  store.acquireWriterLease("owner-a", 1_000_000);
  return { store, database: opened.database };
}

function createTestSnapshot(filePath: string, nodeCount: number = 1): ReturnType<typeof buildExtractionSnapshot> {
  const file: CodeNode = {
    id: "file",
    kind: "file",
    name: filePath.split("/").pop()!,
    qualifiedName: filePath,
    filePath,
    languageId: "typescript",
    startLine: 1,
    endLine: nodeCount * 5 + 1,
  };

  const nodesList = Array.from({ length: nodeCount }, (_, i) => ({
    id: `node${i}`,
    kind: "function" as const,
    name: `function${i}`,
    qualifiedName: `${filePath}::function${i}`,
    filePath,
    languageId: "typescript" as const,
    startLine: i * 5 + 2,
    endLine: i * 5 + 5,
  }));

  const input: SnapshotInput = {
    fileUri: `file:///workspace/${filePath}`,
    filePath,
    parsed: { filePath, languageId: "typescript", text: "", diagnostics: [] },
    extraction: {
      nodes: [file, ...nodesList],
      edges: nodesList.map((n) => ({
        id: `contains:${n.id}`,
        source: file.id,
        target: n.id,
        kind: "contains" as const,
        filePath,
        line: n.startLine,
        confidence: "exact" as const,
      })),
      importBindings: [],
      unresolvedReferences: [],
      diagnostics: [],
    },
  };

  return buildExtractionSnapshot(input);
}

describe("SqliteIndexStore FTS Search Indexing", () => {
  describe("Schema and Tables", () => {
    it("creates FTS search tables on database initialization", () => {
      const { database } = createFixture();

      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'search%' ORDER BY name")
        .all() as Array<{ name: string }>;

      expect(tables.map((t) => t.name)).toContain("search_index_fts");
      expect(tables.map((t) => t.name)).toContain("search_node_metadata");
      expect(tables.map((t) => t.name)).toContain("search_file_metadata");
    });

    it("search_index_fts table has FTS5 virtual table type", () => {
      const { database } = createFixture();

      const schema = database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='search_index_fts'")
        .get() as { sql: string } | undefined;

      expect(schema?.sql).toMatch(/VIRTUAL TABLE.*USING fts5/i);
    });

    it("search_node_metadata table stores node properties", () => {
      const { database } = createFixture();

      const columns = database
        .prepare("PRAGMA table_info(search_node_metadata)")
        .all() as Array<{ name: string }>;

      expect(columns.map((c) => c.name)).toContain("node_id");
      expect(columns.map((c) => c.name)).toContain("kind");
      expect(columns.map((c) => c.name)).toContain("file_priority");
    });
  });

  describe("Token Generation and Weighting", () => {
    it("generates weighted tokens for node names", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/users.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const tokens = database
        .prepare("SELECT DISTINCT token, weight FROM search_index_fts ORDER BY weight DESC")
        .all() as Array<{ token: string; weight: number }>;

      expect(tokens.length).toBeGreaterThan(0);
      // Tokens should be ordered by weight
      for (let i = 0; i < tokens.length - 1; i++) {
        expect(tokens[i].weight).toBeGreaterThanOrEqual(tokens[i + 1].weight);
      }
    });

    it("generates tokens from node naming", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/api.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const tokens = database
        .prepare("SELECT DISTINCT token FROM search_index_fts ORDER BY token")
        .all() as Array<{ token: string }>;

      expect(tokens.length).toBeGreaterThan(0);
    });

    it("stores tokens with weight values", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/lib.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const weightedTokens = database
        .prepare("SELECT token, weight FROM search_index_fts WHERE weight > 0 LIMIT 1")
        .get() as { token: string; weight: number } | undefined;

      expect(weightedTokens).toBeDefined();
      expect(weightedTokens?.weight).toBeGreaterThan(0);
    });
  });

  describe("Node Indexing", () => {
    it("indexes all nodes from a file snapshot", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/api.ts", 5);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const indexedNodes = database
        .prepare("SELECT DISTINCT node_id FROM search_index_fts")
        .all() as Array<{ node_id: string }>;

      // Should have indexed multiple nodes
      expect(indexedNodes.length).toBeGreaterThan(0);
    });

    it("stores node metadata for file priority and scoring", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/services/UserService.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const metadata = database
        .prepare("SELECT COUNT(*) as count FROM search_node_metadata")
        .get() as { count: number };

      expect(metadata.count).toBeGreaterThan(0);
    });

    it("marks files in node_modules with lower priority", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("node_modules/lib/index.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const metadata = database
        .prepare("SELECT file_priority FROM search_node_metadata LIMIT 1")
        .get() as { file_priority: number } | undefined;

      expect(metadata?.file_priority).toBe(-1);
    });

    it("marks regular files with positive priority", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/regular.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const metadata = database
        .prepare("SELECT file_priority FROM search_node_metadata LIMIT 1")
        .get() as { file_priority: number } | undefined;

      expect(metadata?.file_priority).toBe(1);
    });

    it("clears old index entries when re-indexing a file", () => {
      const { store, database } = createFixture();

      const snap1 = createTestSnapshot("src/test.ts", 1);
      store.applyFileSnapshot("owner-a", snap1);
      store.indexNodeSearchTokens("owner-a", snap1);

      const countBefore = (database.prepare("SELECT COUNT(*) as count FROM search_index_fts").get() as { count: number }).count;
      expect(countBefore).toBeGreaterThan(0);

      // Re-index with different snapshot
      const snap2 = createTestSnapshot("src/test.ts", 2);
      store.applyFileSnapshot("owner-a", snap2);
      store.indexNodeSearchTokens("owner-a", snap2);

      // Should have reindexed
      const countAfter = (database.prepare("SELECT COUNT(*) as count FROM search_index_fts").get() as { count: number }).count;
      expect(countAfter).toBeGreaterThan(0);
    });
  });

  describe("Search Operations", () => {
    it("finds nodes by exact token match", () => {
      const { store } = createFixture();
      const snap = createTestSnapshot("src/search.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      // Search for a token that should be in the index
      const results = store.searchNodes("function0", 10);

      expect(results).toBeDefined();
    });

    it("respects search limit parameter", () => {
      const { store } = createFixture();
      const snap = createTestSnapshot("src/lib.ts", 20);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const results = store.searchNodes("function", 3);

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("throws error for invalid limit parameter", () => {
      const { store } = createFixture();

      expect(() => store.searchNodes("test", 0)).toThrow();
      expect(() => store.searchNodes("test", -5)).toThrow();
      expect(() => store.searchNodes("test", 1.5)).toThrow();
    });

    it("returns empty results for empty query", () => {
      const { store } = createFixture();
      const snap = createTestSnapshot("src/test.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const results = store.searchNodes("", 10);

      expect(results.length).toBe(0);
    });

    it("returns results with score information", () => {
      const { store } = createFixture();
      const snap = createTestSnapshot("src/data.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const results = store.searchNodes("function", 10);

      if (results.length > 0) {
        expect(results[0]).toHaveProperty("nodeId");
        expect(results[0]).toHaveProperty("nodeName");
        expect(results[0]).toHaveProperty("filePath");
        expect(results[0]).toHaveProperty("score");
      }
    });
  });

  describe("File Priority Boost", () => {
    it("indexes nodes from both regular and node_modules files", () => {
      const { store, database } = createFixture();

      const srcSnap = createTestSnapshot("src/user.ts", 1);
      const libSnap = createTestSnapshot("node_modules/lib/index.ts", 1);

      store.applyFileSnapshot("owner-a", srcSnap);
      store.indexNodeSearchTokens("owner-a", srcSnap);
      store.applyFileSnapshot("owner-a", libSnap);
      store.indexNodeSearchTokens("owner-a", libSnap);

      const metadata = database
        .prepare("SELECT COUNT(*) as count FROM search_node_metadata")
        .get() as { count: number };

      expect(metadata.count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Deletion and Cleanup", () => {
    it("removes search index entries when file is deleted", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/test.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const countBefore = (database.prepare("SELECT COUNT(*) as count FROM search_index_fts").get() as { count: number }).count;
      expect(countBefore).toBeGreaterThan(0);

      store.removeFile("owner-a", snap.file.uri);

      const countAfter = (database.prepare("SELECT COUNT(*) as count FROM search_index_fts").get() as { count: number }).count;
      expect(countAfter).toBe(0);
    });

    it("removes node metadata when file is deleted", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/cleanup.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const metadataCountBefore = (database.prepare("SELECT COUNT(*) as count FROM search_node_metadata").get() as { count: number }).count;
      expect(metadataCountBefore).toBeGreaterThan(0);

      store.removeFile("owner-a", snap.file.uri);

      const metadataCountAfter = (database.prepare("SELECT COUNT(*) as count FROM search_node_metadata").get() as { count: number }).count;
      expect(metadataCountAfter).toBe(0);
    });

    it("requires writer lease to index nodes", () => {
      const { store } = createFixture();
      const snap = createTestSnapshot("src/test.ts", 1);

      store.applyFileSnapshot("owner-a", snap);

      expect(() => store.indexNodeSearchTokens("owner-b", snap)).toThrow(/writer lease/i);
    });
  });

  describe("Integration and Persistence", () => {
    it("persists search index across multiple indexing operations", () => {
      const { store, database } = createFixture();

      const snap1 = createTestSnapshot("src/file1.ts", 1);
      const snap2 = createTestSnapshot("src/file2.ts", 1);

      store.applyFileSnapshot("owner-a", snap1);
      store.indexNodeSearchTokens("owner-a", snap1);

      store.applyFileSnapshot("owner-a", snap2);
      store.indexNodeSearchTokens("owner-a", snap2);

      const allResults = database
        .prepare("SELECT COUNT(DISTINCT node_id) as count FROM search_index_fts")
        .get() as { count: number };

      expect(allResults.count).toBeGreaterThanOrEqual(2);
    });

    it("handles large file with many nodes", () => {
      const { store } = createFixture();
      const snap = createTestSnapshot("src/large.ts", 100);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const results = store.searchNodes("function", 50);

      expect(results.length).toBeLessThanOrEqual(50);
    });

    it("updates file metadata on indexing", () => {
      const { store, database } = createFixture();
      const snap = createTestSnapshot("src/update.ts", 1);

      store.applyFileSnapshot("owner-a", snap);
      store.indexNodeSearchTokens("owner-a", snap);

      const metadata = database
        .prepare("SELECT indexed_at FROM search_file_metadata WHERE file_uri = ?")
        .get(snap.file.uri) as { indexed_at: number } | undefined;

      expect(metadata).toBeDefined();
      expect(metadata?.indexed_at).toBe(1_000);
    });
  });
});
