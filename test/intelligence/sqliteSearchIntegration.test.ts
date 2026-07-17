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
import { createAsyncSqliteStore } from "./testSupport/asyncSqliteStore";

const OWNER_ID = "owner-integration-test";
const FILE_URI = "file:///workspace/src/user.ts";
const databases: OpenIndexDatabaseResult[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite Search Integration", () => {
  it("indexes symbol and chunk FTS after file creation", async () => {
    const { store, sqliteStore, parserRuntime, files, createIndexer } = setupFixture();

    files.set(FILE_URI, { ref: fileRef("src/user.ts", 1_000), text: "export function testSymbolThirteen() {}" });

    const indexer = createIndexer();
    await indexer.start();

    const nodeResults = sqliteStore.searchNodes("testSymbolThirteen", 10);
    const foundNode = nodeResults.find((n) => n.nodeName === "testSymbolThirteen");
    expect(foundNode).toBeDefined();
    expect(foundNode).toMatchObject({
      nodeName: "testSymbolThirteen",
      kind: "function",
      filePath: "src/user.ts",
    });

    const chunkResults = sqliteStore.searchCodeChunks("testSymbolThirteen", 6);
    expect(chunkResults.some((c) => c.sourceText.includes("testSymbolThirteen"))).toBe(true);

    await indexer.dispose();
  });

  it("updates both indexes when file content changes", async () => {
    const { store, sqliteStore, parserRuntime, files, createIndexer } = setupFixture();

    files.set(FILE_URI, { ref: fileRef("src/user.ts", 1_000), text: "export function testSymbolThirteen() {}" });

    const indexer = createIndexer();
    await indexer.start();

    expect(sqliteStore.searchNodes("testSymbolThirteen", 10).some((n) => n.nodeName === "testSymbolThirteen")).toBe(true);
    expect(sqliteStore.searchNodes("testResultFortyTwo", 10).some((n) => n.nodeName === "testResultFortyTwo")).toBe(false);

    files.set(FILE_URI, { ref: fileRef("src/user.ts", 2_000), text: "export function testResultFortyTwo() {}" });
    await indexer.enqueue({ fileUri: FILE_URI, eventKind: "change" });

    expect(sqliteStore.searchNodes("testSymbolThirteen", 10).some((n) => n.nodeName === "testSymbolThirteen")).toBe(false);
    expect(sqliteStore.searchNodes("testResultFortyTwo", 10).some((n) => n.nodeName === "testResultFortyTwo")).toBe(true);
    expect(sqliteStore.searchCodeChunks("testSymbolThirteen", 6).some((c) => c.sourceText.includes("testSymbolThirteen"))).toBe(false);
    expect(sqliteStore.searchCodeChunks("testResultFortyTwo", 6).some((c) => c.sourceText.includes("testResultFortyTwo"))).toBe(true);

    await indexer.dispose();
  });

  it("removes both indexes when file is deleted", async () => {
    const { store, sqliteStore, parserRuntime, files, createIndexer } = setupFixture();

    files.set(FILE_URI, { ref: fileRef("src/user.ts", 1_000), text: "export function testSymbolThirteen() {}" });

    const indexer = createIndexer();
    await indexer.start();

    expect(sqliteStore.searchNodes("testSymbolThirteen", 10).some((n) => n.nodeName === "testSymbolThirteen")).toBe(true);

    files.delete(FILE_URI);
    await indexer.enqueue({ fileUri: FILE_URI, eventKind: "delete" });

    expect(sqliteStore.searchNodes("testSymbolThirteen", 10).some((n) => n.nodeName === "testSymbolThirteen")).toBe(false);
    expect(sqliteStore.searchCodeChunks("testSymbolThirteen", 6).some((c) => c.sourceText.includes("testSymbolThirteen"))).toBe(false);

    await indexer.dispose();
  });

  it("persists indexes across restart without re-parsing unchanged files", async () => {
    const { store, sqliteStore, parserRuntime, files, directory } = setupFixture();

    files.set(FILE_URI, { ref: fileRef("src/user.ts", 1_000), text: "export function testSymbolThirteen() {}" });

    const indexer = createWorkspaceIndexer({
      ownerId: OWNER_ID,
      store,
      parserRuntime,
      listFiles: async () => [...files.values()].map((file) => file.ref),
      statFile: async (uri) => files.get(uri)?.ref,
      readFile: async (uri) => files.get(uri)!.text,
      maxFileBytes: 100_000,
    });
    await indexer.start();

    expect(sqliteStore.searchNodes("testSymbolThirteen", 10).some((n) => n.nodeName === "testSymbolThirteen")).toBe(true);
    expect(parserRuntime.parse).toHaveBeenCalledTimes(1);
    await indexer.dispose();

    parserRuntime.parse.mockClear();

    const opened = openIndexDatabase(join(directory, "index.sqlite"));
    databases.push(opened);
    const sqliteStoreRestarted = new SqliteIndexStore(opened.database, { now: () => 2_000 });
    sqliteStoreRestarted.acquireWriterLease(OWNER_ID, 1_000_000);
    const storeRestarted = createAsyncSqliteStore(sqliteStoreRestarted, OWNER_ID);

    const indexerRestarted = createWorkspaceIndexer({
      ownerId: OWNER_ID,
      store: storeRestarted,
      parserRuntime,
      listFiles: async () => [...files.values()].map((file) => file.ref),
      statFile: async (uri) => files.get(uri)?.ref,
      readFile: async (uri) => files.get(uri)!.text,
      maxFileBytes: 100_000,
    });
    await indexerRestarted.start();

    expect(parserRuntime.parse).not.toHaveBeenCalled();
    expect(sqliteStoreRestarted.searchNodes("testSymbolThirteen", 10).some((n) => n.nodeName === "testSymbolThirteen")).toBe(true);
    expect(sqliteStoreRestarted.searchCodeChunks("testSymbolThirteen", 6).some((c) => c.sourceText.includes("testSymbolThirteen"))).toBe(true);

    await indexerRestarted.dispose();
  });
});

function fileRef(path: string, mtime: number): WorkspaceFileRef {
  return {
    uri: FILE_URI,
    path,
    languageId: "typescript",
    mtime,
    byteLength: 100,
  };
}

function setupFixture() {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-search-integration-"));
  directories.push(directory);
  const opened = openIndexDatabase(join(directory, "index.sqlite"));
  databases.push(opened);
  const sqliteStore = new SqliteIndexStore(opened.database, { now: () => 1_000 });
  sqliteStore.acquireWriterLease(OWNER_ID, 1_000_000);
  const store = createAsyncSqliteStore(sqliteStore, OWNER_ID);
  const files = new Map<string, { ref: WorkspaceFileRef; text: string }>();
  const parserRuntime = {
    parse: vi.fn(async (filePath: string, languageId: string, text: string) => ({
      filePath,
      languageId,
      text,
      tree: undefined,
      diagnostics: [],
    })),
  };

  const createIndexer = () =>
    createWorkspaceIndexer({
      ownerId: OWNER_ID,
      store,
      parserRuntime,
      listFiles: async () => [...files.values()].map((file) => file.ref),
      statFile: async (uri) => files.get(uri)?.ref,
      readFile: async (uri) => files.get(uri)!.text,
      maxFileBytes: 100_000,
    });

  return { store, sqliteStore, parserRuntime, files, directory, createIndexer };
}
