import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceIndexer,
  type WorkspaceFileRef,
} from "../../src/extension/intelligence/indexing/workspaceIndexer";
import { openIndexDatabase, type OpenIndexDatabaseResult } from "../../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../../src/extension/intelligence/storage/sqliteIndexStore";

const OWNER_ID = "owner-a";
const FILE_URI = "file:///workspace/src/sample.ts";
const databases: OpenIndexDatabaseResult[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkspaceIndexer", () => {
  it("keeps SQLite synchronized across startup, restart, change, and delete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-workspace-indexer-"));
    directories.push(directory);
    const opened = openIndexDatabase(join(directory, "index.sqlite"));
    databases.push(opened);
    const sqliteStore = new SqliteIndexStore(opened.database, { now: () => 1_000 });
    sqliteStore.acquireWriterLease(OWNER_ID, 1_000_000);
    const store = createAsyncStore(sqliteStore);
    const files = new Map([[FILE_URI, source("export function run() {}", 1_000)]]);
    const parserRuntime = {
      parse: vi.fn(async (filePath: string, languageId: string, text: string) => ({
        filePath,
        languageId,
        text,
        tree: undefined,
        diagnostics: [],
      })),
    };
    const createIndexer = () => createWorkspaceIndexer({
      ownerId: OWNER_ID,
      store,
      parserRuntime,
      listFiles: async () => [...files.values()].map((file) => file.ref),
      statFile: async (uri) => files.get(uri)?.ref,
      readFile: async (uri) => files.get(uri)!.text,
      maxFileBytes: 100_000,
    });

    const first = createIndexer();
    await first.start();
    expect(cardText(opened)).toContain("run");
    await first.dispose();

    parserRuntime.parse.mockClear();
    const restarted = createIndexer();
    await restarted.start();
    expect(parserRuntime.parse).not.toHaveBeenCalled();

    files.set(FILE_URI, source("export function run() {}", 1_500));
    await restarted.enqueue({ fileUri: FILE_URI, eventKind: "change" });
    expect(parserRuntime.parse).not.toHaveBeenCalled();
    expect((await store.listIndexedFiles())[0]?.mtime).toBe(1_500);

    files.set(FILE_URI, source("export function renamed() {}", 2_000));
    await restarted.enqueue({ fileUri: FILE_URI, eventKind: "change" });
    expect(cardText(opened)).toContain("renamed");

    parserRuntime.parse.mockRejectedValueOnce(new Error("parse failed"));
    files.set(FILE_URI, source("export function broken() {}", 3_000));
    await restarted.enqueue({ fileUri: FILE_URI, eventKind: "change" });
    expect(cardText(opened)).toContain("renamed");
    expect(sqliteStore.listJobs()).toEqual([
      expect.objectContaining({ fileUri: FILE_URI, status: "failed", lastError: "parse failed" }),
    ]);

    files.delete(FILE_URI);
    await restarted.enqueue({ fileUri: FILE_URI, eventKind: "delete" });
    expect(fileFacts(opened)).toEqual({ files: 0, chunks: 0, fts: 0 });
    await restarted.dispose();
  });
});

function source(text: string, mtime: number): { ref: WorkspaceFileRef; text: string } {
  return {
    ref: {
      uri: FILE_URI,
      path: "src/sample.ts",
      languageId: "typescript",
      mtime,
      byteLength: Buffer.byteLength(text, "utf8"),
    },
    text,
  };
}

function createAsyncStore(store: SqliteIndexStore) {
  return {
    getStatus: async () => ({
      state: "ready" as const,
      role: "writer" as const,
      schemaVersion: 1,
      capabilities: { sqlite: true, wal: true, foreignKeys: true, fts5: true },
    }),
    listIndexedFiles: async () => store.listIndexedFiles(),
    enqueueChanges: async (changes: Parameters<SqliteIndexStore["enqueueChanges"]>[1]) => {
      store.enqueueChanges(OWNER_ID, changes);
    },
    claimNextJob: async (ownerId: string) => store.claimNextJob(ownerId),
    applyFileSnapshot: async (snapshot: Parameters<SqliteIndexStore["applyFileSnapshot"]>[1]) => {
      store.applyFileSnapshot(OWNER_ID, snapshot);
    },
    updateFileMetadata: async (update: Parameters<SqliteIndexStore["updateFileMetadata"]>[1]) => {
      store.updateFileMetadata(OWNER_ID, update);
    },
    removeFile: async (fileUri: string) => {
      store.removeFile(OWNER_ID, fileUri);
    },
    completeJob: async (claim: Parameters<SqliteIndexStore["completeJob"]>[1]) => {
      store.completeJob(OWNER_ID, claim);
    },
    failJob: async (claim: Parameters<SqliteIndexStore["failJob"]>[1], error: string) => {
      store.failJob(OWNER_ID, claim, error);
    },
  };
}

function cardText(opened: OpenIndexDatabaseResult): string {
  return (opened.database.prepare("SELECT source_text FROM chunks ORDER BY id").all() as Array<{ source_text: string }>)
    .map((row) => row.source_text)
    .join("\n");
}

function fileFacts(opened: OpenIndexDatabaseResult): { files: number; chunks: number; fts: number } {
  const count = (table: string) => Number((opened.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  return { files: count("files"), chunks: count("chunks"), fts: count("chunk_fts") };
}
