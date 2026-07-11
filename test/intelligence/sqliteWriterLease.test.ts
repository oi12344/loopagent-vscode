import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openIndexDatabase, type OpenIndexDatabaseResult } from "../../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../../src/extension/intelligence/storage/sqliteIndexStore";

type FakeClock = {
  now(): number;
  advance(milliseconds: number): void;
};

const databases: OpenIndexDatabaseResult[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeClock(initial: number): FakeClock {
  let current = initial;
  return {
    now: () => current,
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}

function createTwoStores(clock: FakeClock): {
  first: SqliteIndexStore;
  second: SqliteIndexStore;
  firstDatabase: OpenIndexDatabaseResult;
} {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-writer-lease-"));
  directories.push(directory);
  const databasePath = join(directory, "index.sqlite");
  const firstDatabase = openIndexDatabase(databasePath);
  const secondDatabase = openIndexDatabase(databasePath);
  databases.push(firstDatabase, secondDatabase);
  return {
    first: new SqliteIndexStore(firstDatabase.database, { now: clock.now }),
    second: new SqliteIndexStore(secondDatabase.database, { now: clock.now }),
    firstDatabase,
  };
}

describe("SqliteIndexStore writer lease", () => {
  it("allows at most one writer and permits takeover after expiry", () => {
    const clock = fakeClock(10_000);
    const { first, second } = createTwoStores(clock);

    expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
    expect(second.acquireWriterLease("owner-b", 30_000)).toBe(false);
    clock.advance(30_001);
    expect(second.acquireWriterLease("owner-b", 30_000)).toBe(true);
    expect(first.renewWriterLease("owner-a", 30_000)).toBe(false);
  });

  it("renews only an active owner lease", () => {
    const clock = fakeClock(10_000);
    const { first, second } = createTwoStores(clock);

    expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
    clock.advance(10_000);
    expect(first.renewWriterLease("owner-a", 30_000)).toBe(true);
    expect(second.renewWriterLease("owner-b", 30_000)).toBe(false);
    clock.advance(30_001);
    expect(first.renewWriterLease("owner-a", 30_000)).toBe(false);
  });

  it("does not let a non-owner release the lease", () => {
    const clock = fakeClock(10_000);
    const { first, second } = createTwoStores(clock);

    expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
    second.releaseWriterLease("owner-b");
    expect(first.renewWriterLease("owner-a", 30_000)).toBe(true);
    first.releaseWriterLease("owner-a");
    expect(second.acquireWriterLease("owner-b", 30_000)).toBe(true);
  });

  it("rejects writes guarded by a missing, foreign, or expired lease", () => {
    const clock = fakeClock(10_000);
    const { first } = createTwoStores(clock);

    expect(() => first.assertWriterLease("owner-a")).toThrow(/writer lease/i);
    expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
    expect(() => first.assertWriterLease("owner-b")).toThrow(/writer lease/i);
    expect(() => first.assertWriterLease("owner-a")).not.toThrow();
    clock.advance(30_001);
    expect(() => first.assertWriterLease("owner-a")).toThrow(/writer lease/i);
  });

  it("checks the lease and commits a guarded write in one transaction", () => {
    const clock = fakeClock(10_000);
    const { first } = createTwoStores(clock);
    expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
    first.enqueueFileEvent("owner-a", "file:///src/accepted.ts", "change");
    clock.advance(30_001);

    expect(() => first.enqueueFileEvent("owner-a", "file:///src/rejected.ts", "change"))
      .toThrow(/writer lease/i);
    expect(first.listJobs().map((job) => job.fileUri)).toEqual(["file:///src/accepted.ts"]);
  });

  it("treats the exact expiry instant as expired", () => {
    const clock = fakeClock(10_000);
    const { first, second } = createTwoStores(clock);
    expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
    clock.advance(30_000);

    expect(() => first.assertWriterLease("owner-a")).toThrow(/writer lease/i);
    expect(second.acquireWriterLease("owner-b", 30_000)).toBe(true);
  });

  it.each([
    ["missing expiry", [["writer_owner", "owner-a"]]],
    ["missing owner", [["writer_lease_expires_at", "40000"]]],
    ["invalid expiry", [["writer_owner", "owner-a"], ["writer_lease_expires_at", "invalid"]]],
    ["empty owner", [["writer_owner", ""], ["writer_lease_expires_at", "40000"]]],
  ])("fails closed for %s metadata", (_name, entries) => {
    const clock = fakeClock(10_000);
    const { second, firstDatabase } = createTwoStores(clock);
    const insert = firstDatabase.database.prepare("INSERT INTO index_meta(key, value) VALUES (?, ?)");
    for (const [key, value] of entries) insert.run(key, value);

    expect(() => second.acquireWriterLease("owner-b", 30_000)).toThrow(/corrupt writer lease/i);
  });
});
