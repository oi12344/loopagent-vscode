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

  postMessage(request: SqliteWorkerRequest): void {
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

describe("SqliteIndexWorkerClient", () => {
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

  it("rejects pending work and terminates exactly once when repeatedly disposed", async () => {
    const worker = new FakeWorker();
    const client = createSqliteIndexWorkerClient({ worker });
    const pendingStatus = client.getStatus();

    const firstDispose = client.dispose();
    const secondDispose = client.dispose();

    expect(secondDispose).toBe(firstDispose);
    await expect(pendingStatus).rejects.toThrow(/disposed/i);
    await expect(firstDispose).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pendingRequestCount(client)).toBe(0);
    await expect(client.getStatus()).rejects.toThrow(/disposed/i);
    expect(worker.requests).toHaveLength(1);
  });
});
