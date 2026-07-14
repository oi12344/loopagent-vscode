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
  const directory = mkdtempSync(join(tmpdir(), "loopagent-snapshot-store-"));
  directories.push(directory);
  const opened = openIndexDatabase(join(directory, "index.sqlite"));
  databases.push(opened);
  const store = new SqliteIndexStore(opened.database, { now: () => 1_000 });
  store.acquireWriterLease("owner-a", 1_000_000);
  return { store, database: opened.database };
}

function input(functionStartLine: number, includeHelper = true): SnapshotInput {
  const file: CodeNode = {
    id: "file:sample", kind: "file", name: "sample.ts", qualifiedName: "src/sample.ts", filePath: "src/sample.ts",
    languageId: "typescript", startLine: 1, endLine: functionStartLine + 3,
  };
  const run: CodeNode = {
    id: "run", kind: "function", name: "run", qualifiedName: "src/sample.ts::run", filePath: "src/sample.ts",
    languageId: "typescript", startLine: functionStartLine, endLine: functionStartLine + 1, signature: "run(): void",
  };
  const helper: CodeNode = {
    id: "helper", kind: "function", name: "helper", qualifiedName: "src/sample.ts::helper", filePath: "src/sample.ts",
    languageId: "typescript", startLine: functionStartLine + 2, endLine: functionStartLine + 3, signature: "helper(): void",
  };
  const nodes = includeHelper ? [file, run, helper] : [file, run];
  return {
    fileUri: "file:///workspace/src/sample.ts",
    filePath: "src/sample.ts",
    parsed: { filePath: "src/sample.ts", languageId: "typescript", text: "function run() {}\nfunction helper() {}", diagnostics: [] },
    extraction: {
      nodes,
      edges: nodes.slice(1).map((node) => ({
        id: `contains:${node.id}`, source: file.id, target: node.id, kind: "contains" as const,
        filePath: file.filePath, line: node.startLine, confidence: "exact" as const,
      })),
      importBindings: [], unresolvedReferences: [], diagnostics: [],
    },
  };
}

describe("SqliteIndexStore snapshot persistence", () => {
  it("keeps unchanged cards and FTS rows when only ranges move", () => {
    const { store, database } = createFixture();
    const first = buildExtractionSnapshot(input(5));
    const moved = buildExtractionSnapshot(input(25));

    store.applyFileSnapshot("owner-a", first);
    const before = database.prepare("SELECT id, updated_at FROM chunks ORDER BY id").all();
    const ftsBefore = database.prepare("SELECT chunk_id, search_text FROM chunk_fts ORDER BY chunk_id").all();
    store.applyFileSnapshot("owner-a", moved);

    expect(database.prepare("SELECT id, updated_at FROM chunks ORDER BY id").all()).toEqual(before);
    expect(database.prepare("SELECT chunk_id, search_text FROM chunk_fts ORDER BY chunk_id").all()).toEqual(ftsBefore);
  });

  it("removes stale cards and rolls back a failed replacement", () => {
    const { store, database } = createFixture();
    const initial = buildExtractionSnapshot(input(5));
    store.applyFileSnapshot("owner-a", initial);
    store.applyFileSnapshot("owner-a", buildExtractionSnapshot(input(5, false)));

    expect(database.prepare("SELECT name FROM nodes WHERE file_id = ? ORDER BY name").all(initial.file.id)).toEqual([
      { name: "run" },
      { name: "sample.ts" },
    ]);
    database.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON chunks WHEN NEW.id = 'broken' BEGIN SELECT RAISE(ABORT, 'reject snapshot'); END;");
    const broken = { ...initial, chunks: [{ ...initial.chunks[0]!, id: "broken" }] };

    expect(() => store.applyFileSnapshot("owner-a", broken)).toThrow(/reject snapshot/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM chunks WHERE file_id = ?").get(initial.file.id)).toEqual({ count: 2 });
  });
});
