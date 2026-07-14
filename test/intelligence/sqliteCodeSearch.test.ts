import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildExtractionSnapshot, type SnapshotInput } from "../../src/extension/intelligence/indexing/extractionSnapshot";
import { openIndexDatabase, type OpenIndexDatabaseResult } from "../../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../../src/extension/intelligence/storage/sqliteIndexStore";
import type { CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const databases: OpenIndexDatabaseResult[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteIndexStore searchCodeChunks", () => {
  it("returns bounded persisted chunks for safe query tokens", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-code-search-"));
    directories.push(directory);
    const opened = openIndexDatabase(join(directory, "index.sqlite"));
    databases.push(opened);
    const store = new SqliteIndexStore(opened.database, { now: () => 1_000 });
    store.acquireWriterLease("owner-a", 1_000_000);
    store.applyFileSnapshot("owner-a", buildExtractionSnapshot(snapshotInput()));

    expect(store.searchCodeChunks("create Agent", 1)).toEqual([
      expect.objectContaining({
        filePath: "src/agent.ts",
        startLine: 1,
        sourceText: expect.stringContaining("createAgent"),
      }),
    ]);
    expect(store.searchCodeChunks('create OR "unterminated *', 1)).toHaveLength(1);
    expect(store.searchCodeChunks("***", 1)).toEqual([]);
    expect(() => store.searchCodeChunks("create", 7)).toThrow(/limit/i);

    opened.database.prepare("UPDATE files SET path = '.env'").run();
    expect(store.searchCodeChunks("create", 1)).toEqual([]);
  });
});

function snapshotInput(): SnapshotInput {
  const file: CodeNode = {
    id: "file:agent",
    kind: "file",
    name: "agent.ts",
    qualifiedName: "src/agent.ts",
    filePath: "src/agent.ts",
    languageId: "typescript",
    startLine: 1,
    endLine: 1,
  };
  const agent: CodeNode = {
    id: "agent",
    kind: "function",
    name: "createAgent",
    qualifiedName: "src/agent.ts::createAgent",
    filePath: "src/agent.ts",
    languageId: "typescript",
    startLine: 1,
    endLine: 1,
    signature: "createAgent(): void",
  };
  return {
    fileUri: "file:///workspace/src/agent.ts",
    filePath: file.filePath,
    parsed: {
      filePath: file.filePath,
      languageId: file.languageId,
      text: "export function createAgent() {}",
      diagnostics: [],
    },
    extraction: {
      nodes: [file, agent],
      edges: [],
      importBindings: [],
      unresolvedReferences: [],
      diagnostics: [],
    },
  };
}
