import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteIndexWorkerRuntime } from "../../src/extension/intelligence/storage/sqliteIndexWorkerRuntime";
import type { SqliteCapabilities } from "../../src/extension/intelligence/storage/sqliteCapabilities";

const capabilities: SqliteCapabilities = { sqlite: true, wal: true, foreignKeys: true, fts5: true };

afterEach(() => {
  vi.useRealTimers();
});

function createFixture({ acquired = true }: { acquired?: boolean } = {}) {
  vi.useFakeTimers();
  const store = {
    acquireWriterLease: vi.fn(() => acquired),
    renewWriterLease: vi.fn(() => true),
    releaseWriterLease: vi.fn(),
    recoverInterruptedJobs: vi.fn(() => 0),
    enqueueChanges: vi.fn(),
    listPendingJobs: vi.fn(() => []),
    claimNextJob: vi.fn(),
    completeJob: vi.fn(),
    failJob: vi.fn(),
  };
  const database = { database: {} as never, close: vi.fn() };
  const statuses: unknown[] = [];
  const createStore = vi.fn(() => store);
  const runtime = createSqliteIndexWorkerRuntime({
    ttlMs: 30_000,
    staleJobMs: 60_000,
    probe: vi.fn(() => capabilities),
    openDatabase: vi.fn(() => database),
    createStore,
    onStatus: (status) => statuses.push(status),
  });
  return { runtime, store, database, statuses, createStore };
}

describe("SQLite worker lease lifecycle", () => {
  it("falls back to read_only after renewal failure and later recovers", async () => {
    const fixture = createFixture();
    fixture.runtime.initialize("index.sqlite", "owner-a");
    expect(fixture.runtime.getStatus().role).toBe("writer");
    fixture.store.renewWriterLease.mockReturnValueOnce(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.runtime.getStatus().role).toBe("read_only");
    expect(() => fixture.runtime.claimNextJob("owner-a")).toThrow(/read.only/i);
    fixture.store.acquireWriterLease.mockReturnValueOnce(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fixture.runtime.getStatus().role).toBe("writer");
    expect(fixture.store.recoverInterruptedJobs).toHaveBeenCalledWith("owner-a", { staleAfterMs: 60_000 });
  });

  it("starts read_only when another writer owns the lease", async () => {
    const fixture = createFixture({ acquired: false });
    fixture.runtime.initialize("index.sqlite", "owner-b");

    expect(fixture.runtime.getStatus()).toMatchObject({ state: "ready", role: "read_only" });
    expect(() => fixture.runtime.enqueueChanges([])).toThrow(/read.only/i);
    fixture.store.acquireWriterLease.mockReturnValueOnce(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.runtime.getStatus().role).toBe("writer");
  });

  it("periodically recovers jobs that become stale after lease takeover", async () => {
    const fixture = createFixture();
    fixture.runtime.initialize("index.sqlite", "owner-a");
    expect(fixture.store.recoverInterruptedJobs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(fixture.store.renewWriterLease).toHaveBeenCalledTimes(2);
    expect(fixture.store.recoverInterruptedJobs).toHaveBeenCalledTimes(3);
  });

  it("disposes timers, releases only its owner lease, and closes the database", async () => {
    const fixture = createFixture();
    fixture.runtime.initialize("index.sqlite", "owner-a");
    fixture.runtime.dispose();

    expect(fixture.store.releaseWriterLease).toHaveBeenCalledWith("owner-a");
    expect(fixture.database.close).toHaveBeenCalledOnce();
    expect(fixture.runtime.getStatus().state).toBe("closed");
    const renewalCalls = fixture.store.renewWriterLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.store.renewWriterLease).toHaveBeenCalledTimes(renewalCalls);
  });

  it("enters failed and closes an opened database when initialization fails", () => {
    const fixture = createFixture();
    fixture.createStore.mockImplementationOnce(() => { throw new Error("store failed"); });

    expect(() => fixture.runtime.initialize("index.sqlite", "owner-a")).toThrow("store failed");
    expect(fixture.runtime.getStatus().state).toBe("failed");
    expect(fixture.database.close).toHaveBeenCalledOnce();
  });

  it("reports failed when reinitialization cleanup throws", () => {
    const fixture = createFixture();
    fixture.runtime.initialize("first.sqlite", "owner-a");
    fixture.store.releaseWriterLease.mockImplementationOnce(() => { throw new Error("release failed"); });

    expect(() => fixture.runtime.initialize("second.sqlite", "owner-b")).toThrow("release failed");
    expect(fixture.runtime.getStatus()).toMatchObject({ state: "failed", role: "read_only" });
  });

  it("preserves initialization failure and publishes failed when cleanup also throws", () => {
    const fixture = createFixture();
    fixture.createStore.mockImplementationOnce(() => { throw new Error("store failed"); });
    fixture.database.close.mockImplementationOnce(() => { throw new Error("checkpoint failed"); });

    expect(() => fixture.runtime.initialize("index.sqlite", "owner-a")).toThrow("store failed");
    expect(fixture.runtime.getStatus()).toMatchObject({ state: "failed", role: "read_only" });
  });
});
