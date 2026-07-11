import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createSqliteIndexWorkerClient } from "../../src/extension/intelligence/storage/sqliteIndexWorkerClient";
import type {
  SqliteWorkerRequest,
  SqliteWorkerResponse,
} from "../../src/extension/intelligence/storage/sqliteIndexWorkerProtocol";

class FakeWorker extends EventEmitter {
  readonly requests: SqliteWorkerRequest[] = [];
  readonly terminate = vi.fn(() => Promise.resolve(0));
  postMessageError: Error | undefined;

  postMessage(request: SqliteWorkerRequest): void {
    if (this.postMessageError) {
      throw this.postMessageError;
    }
    this.requests.push(request);
  }

  respond(response: SqliteWorkerResponse): void {
    this.emit("message", response);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  exit(code: number): void {
    this.emit("exit", code);
  }
}

function pendingRequestCount(client: unknown): number {
  return (
    client as { pendingRequests: ReadonlyMap<number, unknown> }
  ).pendingRequests.size;
}

function observeSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

describe("SqliteIndexWorkerClient", () => {
  it("sends fixed job queue DTOs without exposing SQL", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const claim = { id: 7, fileUri: "file:///src/a.ts", eventKind: "change" as const, claimedAt: 2_000 };

    const enqueue = client.enqueueChanges([{ fileUri: "file:///src/a.ts", eventKind: "change" }]);
    worker.respond({ id: 1, ok: true, value: undefined });
    await enqueue;
    const pending = client.getPendingJobs();
    worker.respond({ id: 2, ok: true, value: [] });
    await expect(pending).resolves.toEqual([]);
    const claimed = client.claimNextJob("owner-a");
    worker.respond({ id: 3, ok: true, value: claim });
    await expect(claimed).resolves.toEqual(claim);
    const completed = client.completeJob(claim);
    worker.respond({ id: 4, ok: true, value: undefined });
    await completed;
    const failed = client.failJob(claim, "parse failed");
    worker.respond({ id: 5, ok: true, value: undefined });
    await failed;

    expect(worker.requests).toEqual([
      { id: 1, kind: "enqueueChanges", changes: [{ fileUri: "file:///src/a.ts", eventKind: "change" }] },
      { id: 2, kind: "getPendingJobs" },
      { id: 3, kind: "claimNextJob", ownerId: "owner-a" },
      { id: 4, kind: "completeJob", claim },
      { id: 5, kind: "failJob", claim, error: "parse failed" },
    ]);
    expect(JSON.stringify(worker.requests)).not.toContain("SELECT");
  });

  it("increments request IDs and matches out-of-order responses", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });

    const probe = client.probe("E:/tmp/probe.sqlite");
    const status = client.getStatus();

    expect(worker.requests).toEqual([
      { id: 1, kind: "probe", databasePath: "E:/tmp/probe.sqlite" },
      { id: 2, kind: "getStatus" },
    ]);

    worker.respond({ id: 2, ok: true, value: { state: "idle" } });
    worker.respond({ id: 1, ok: true, value: { sqlite: true } });

    await expect(status).resolves.toEqual({ state: "idle" });
    await expect(probe).resolves.toEqual({ sqlite: true });
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("propagates failed responses and clears their pending requests", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const probe = client.probe("E:/tmp/probe.sqlite");

    worker.respond({ id: 1, ok: false, error: "probe failed" });

    await expect(probe).rejects.toThrow("probe failed");
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("ignores unknown and duplicate responses without disturbing other pending requests", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const probe = client.probe("E:/tmp/probe.sqlite");
    const status = client.getStatus();

    worker.respond({ id: 1, ok: true, value: { sqlite: true } });
    worker.respond({ id: 1, ok: false, error: "late duplicate" });
    worker.respond({ id: 999, ok: false, error: "unknown response" });
    worker.respond({ id: 2, ok: true, value: { state: "idle" } });

    await expect(probe).resolves.toEqual({ sqlite: true });
    await expect(status).resolves.toEqual({ state: "idle" });
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("rejects every pending request with the original worker error", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const probe = client.probe("E:/tmp/probe.sqlite");
    const status = client.getStatus();
    const workerError = new Error("worker failed");

    worker.fail(workerError);

    await expect(probe).rejects.toBe(workerError);
    await expect(status).rejects.toBe(workerError);
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("rejects every pending request when the worker exits nonzero", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const probe = client.probe("E:/tmp/probe.sqlite");
    const status = client.getStatus();

    worker.exit(7);

    await expect(probe).rejects.toThrow(/exited.*7/i);
    await expect(status).rejects.toThrow(/exited.*7/i);
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("does not leave pending requests unresolved after a zero exit", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const status = client.getStatus();

    worker.exit(0);

    await expect(status).rejects.toThrow(/exited.*0/i);
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("rejects public work immediately and waits for the dispose response before terminating", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const pendingStatus = client.getStatus();

    const firstDispose = client.dispose();
    const secondDispose = client.dispose();
    const isDisposeSettled = observeSettlement(firstDispose);

    expect(secondDispose).toBe(firstDispose);
    await expect(pendingStatus).rejects.toThrow(/disposed/i);
    expect(worker.requests).toEqual([
      { id: 1, kind: "getStatus" },
      { id: 2, kind: "dispose" },
    ]);
    expect(worker.terminate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(isDisposeSettled()).toBe(false);

    worker.respond({ id: 2, ok: true, value: undefined });

    await expect(firstDispose).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
    await expect(client.getStatus()).rejects.toThrow(/disposed/i);
    expect(worker.requests).toHaveLength(2);
  });

  it("terminates and rejects dispose when posting the dispose request throws", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const postMessageError = new Error("post dispose failed");
    worker.postMessageError = postMessageError;

    await expect(client.dispose()).rejects.toBe(postMessageError);

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("terminates and rejects dispose when the worker reports an error", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const workerError = new Error("worker failed during dispose");
    const dispose = client.dispose();

    worker.fail(workerError);

    await expect(dispose).rejects.toBe(workerError);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("terminates and rejects dispose when the worker exits before responding", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const dispose = client.dispose();

    worker.exit(0);

    await expect(dispose).rejects.toThrow(/exited.*0/i);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("terminates with the original error when disposed after the worker stopped", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const workerError = new Error("worker already stopped");
    worker.fail(workerError);

    await expect(client.dispose()).rejects.toBe(workerError);

    expect(worker.requests).toHaveLength(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("terminates and preserves a failed dispose response", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const dispose = client.dispose();

    worker.respond({ id: 1, ok: false, error: "dispose failed" });

    await expect(dispose).rejects.toThrow("dispose failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("propagates terminate failures after a successful dispose response", async () => {
    const worker = new FakeWorker();
    const terminateError = new Error("terminate failed");
    worker.terminate.mockRejectedValueOnce(terminateError);
    const client = createSqliteIndexWorkerClient({ worker });
    const dispose = client.dispose();

    worker.respond({ id: 1, ok: true, value: undefined });

    await expect(dispose).rejects.toBe(terminateError);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("settles a request when postMessage throws without retaining it", async () => {
    const worker = new FakeWorker();
    const postMessageError = new Error("post request failed");
    worker.postMessageError = postMessageError;
    const client = createSqliteIndexWorkerClient({ worker });

    await expect(client.getStatus()).rejects.toBe(postMessageError);

    expect(worker.requests).toHaveLength(0);
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("keeps the original failure across exit and rejects later requests without posting", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const pendingStatus = client.getStatus();
    const workerError = new Error("original worker failure");

    worker.fail(workerError);
    worker.exit(9);

    await expect(pendingStatus).rejects.toBe(workerError);
    await expect(client.getStatus()).rejects.toBe(workerError);
    expect(worker.requests).toHaveLength(1);
    expect(pendingRequestCount(client)).toBe(0);
  });

  it("ignores late worker events after disposal without terminating twice", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const dispose = client.dispose();

    worker.respond({ id: 1, ok: true, value: undefined });
    await expect(dispose).resolves.toBeUndefined();

    worker.fail(new Error("late worker error"));
    worker.exit(0);

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
  });
});
