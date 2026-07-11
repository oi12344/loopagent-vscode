import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openIndexDatabase, type OpenIndexDatabaseResult } from "../../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../../src/extension/intelligence/storage/sqliteIndexStore";

const databases: OpenIndexDatabaseResult[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(now: () => number = () => Date.now()): SqliteIndexStore {
  return createStoreFixture(now).store;
}

function createStoreFixture(now: () => number = () => Date.now()): {
  store: SqliteIndexStore;
  database: OpenIndexDatabaseResult;
} {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-index-jobs-"));
  directories.push(directory);
  const database = openIndexDatabase(join(directory, "index.sqlite"));
  databases.push(database);
  const store = new SqliteIndexStore(database.database, { now });
  store.acquireWriterLease("owner-a", 1_000_000);
  return { store, database };
}

describe("SqliteIndexStore jobs", () => {
  it("merges queued events to the latest filesystem intent", () => {
    const store = createStore(() => 1_000);
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "create");
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "change");
    store.enqueueFileEvent("owner-a", "file:///src/b.ts", "change");
    store.enqueueFileEvent("owner-a", "file:///src/b.ts", "delete");

    expect(store.listPendingJobs()).toMatchObject([
      { fileUri: "file:///src/a.ts", eventKind: "change", status: "pending", attempts: 0 },
      { fileUri: "file:///src/b.ts", eventKind: "delete", status: "pending", attempts: 0 },
    ]);
  });

  it("keeps a new event queued when it arrives during a running job", () => {
    let now = 1_000;
    const store = createStore(() => now);
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "change");
    now = 2_000;
    const claimed = store.claimNextJob("owner-a")!;
    now = 3_000;
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "delete");
    store.completeJob("owner-a", claimed);

    expect(store.listPendingJobs()).toMatchObject([
      { fileUri: "file:///src/a.ts", eventKind: "delete", status: "pending", attempts: 1 },
    ]);
  });

  it("does not let an old completion delete a same-millisecond re-claim", () => {
    const store = createStore(() => 1_000);
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "change");
    const first = store.claimNextJob("owner-a")!;
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "delete");
    const second = store.claimNextJob("owner-a")!;

    expect(second.claimedAt).toBeGreaterThan(first.claimedAt);
    store.completeJob("owner-a", first);
    expect(store.listJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileUri: "file:///src/a.ts", status: "running", eventKind: "delete" }),
    ]));
  });

  it("rolls back an entire change batch when one enqueue fails", () => {
    const { store, database } = createStoreFixture(() => 1_000);
    database.database.exec(`
      CREATE TRIGGER reject_test_job BEFORE INSERT ON index_jobs
      WHEN NEW.file_uri = 'file:///src/fail.ts'
      BEGIN SELECT RAISE(ABORT, 'test enqueue failure'); END;
    `);

    expect(() => store.enqueueChanges("owner-a", [
      { fileUri: "file:///src/ok.ts", eventKind: "change" },
      { fileUri: "file:///src/fail.ts", eventKind: "change" },
    ])).toThrow(/test enqueue failure/i);
    expect(store.listJobs()).toEqual([]);
  });

  it("records a matching running job failure", () => {
    let now = 1_000;
    const store = createStore(() => now);
    store.enqueueFileEvent("owner-a", "file:///src/a.ts", "change");
    now = 2_000;
    const claimed = store.claimNextJob("owner-a")!;
    now = 3_000;
    store.failJob("owner-a", claimed, "parse failed");

    expect(store.listJobs()).toMatchObject([
      { fileUri: "file:///src/a.ts", status: "failed", lastError: "parse failed", attempts: 1 },
    ]);
  });

  it("recovers only stale running jobs", () => {
    let now = 1_000;
    const store = createStore(() => now);
    store.enqueueFileEvent("owner-a", "file:///src/stale.ts", "change");
    store.claimNextJob("owner-a");
    now = 8_000;
    store.enqueueFileEvent("owner-a", "file:///src/fresh.ts", "change");
    store.claimNextJob("owner-a");
    now = 10_000;

    expect(store.recoverInterruptedJobs("owner-a", { staleAfterMs: 5_000 })).toBe(1);
    expect(store.listJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileUri: "file:///src/stale.ts", status: "pending" }),
      expect.objectContaining({ fileUri: "file:///src/fresh.ts", status: "running" }),
    ]));
  });

  it("lists only claimable jobs through the pending API", () => {
    const store = createStore(() => 1_000);
    store.enqueueFileEvent("owner-a", "file:///src/running.ts", "change");
    store.claimNextJob("owner-a");
    store.enqueueFileEvent("owner-a", "file:///src/pending.ts", "change");

    expect(store.listPendingJobs()).toMatchObject([
      { fileUri: "file:///src/pending.ts", status: "pending" },
    ]);
  });
});
