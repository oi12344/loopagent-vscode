import { parentPort } from "node:worker_threads";

import { probeSqliteCapabilities } from "./sqliteCapabilities";
import { openIndexDatabase, type OpenIndexDatabaseResult } from "./indexDatabase";
import { SqliteIndexStore } from "./sqliteIndexStore";
import type {
  SqliteWorkerRequest,
  SqliteWorkerResponse,
} from "./sqliteIndexWorkerProtocol";

if (!parentPort) {
  throw new Error("SQLite index worker requires a parent port");
}
const workerPort = parentPort;
const WRITER_LEASE_TTL_MS = 30_000;

let closing = false;
let requestQueue = Promise.resolve();
let indexDatabase: OpenIndexDatabaseResult | undefined;
let indexStore: SqliteIndexStore | undefined;
let indexOwnerId: string | undefined;

workerPort.on("message", (request: SqliteWorkerRequest) => {
  requestQueue = requestQueue.then(() => {
    if (!closing) {
      handleRequest(request);
    }
  });
});

function handleRequest(request: SqliteWorkerRequest): void {
  try {
    const value = dispatch(request);
    postResponse({ id: request.id, ok: true, value });
    if (request.kind === "dispose") {
      closing = true;
      workerPort.close();
    }
  } catch (error) {
    postResponse({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function dispatch(request: SqliteWorkerRequest): unknown {
  switch (request.kind) {
    case "probe":
      return probeSqliteCapabilities(request.databasePath);
    case "initialize": {
      const previousDatabase = indexDatabase;
      const previousStore = indexStore;
      const previousOwnerId = indexOwnerId;
      indexDatabase = undefined;
      indexStore = undefined;
      indexOwnerId = undefined;
      if (previousStore && previousOwnerId) previousStore.releaseWriterLease(previousOwnerId);
      previousDatabase?.close();
      const capabilities = probeSqliteCapabilities(request.databasePath);
      indexDatabase = openIndexDatabase(request.databasePath);
      indexStore = new SqliteIndexStore(indexDatabase.database);
      indexOwnerId = request.ownerId;
      indexStore.acquireWriterLease(request.ownerId, WRITER_LEASE_TTL_MS);
      return { schemaVersion: 1, capabilities };
    }
    case "enqueueChanges": {
      const writer = ensureWriter();
      writer.store.enqueueChanges(writer.ownerId, request.changes);
      return undefined;
    }
    case "getPendingJobs":
      return requireStore().listPendingJobs();
    case "claimNextJob": {
      const writer = ensureWriter(request.ownerId);
      return writer.store.claimNextJob(writer.ownerId);
    }
    case "completeJob": {
      const writer = ensureWriter();
      writer.store.completeJob(writer.ownerId, request.claim);
      return undefined;
    }
    case "failJob": {
      const writer = ensureWriter();
      writer.store.failJob(writer.ownerId, request.claim, request.error);
      return undefined;
    }
    case "getStatus":
      return { state: "idle" };
    case "dispose":
      if (indexStore && indexOwnerId) indexStore.releaseWriterLease(indexOwnerId);
      indexDatabase?.close();
      indexDatabase = undefined;
      indexStore = undefined;
      indexOwnerId = undefined;
      return undefined;
  }
}

function requireStore(): SqliteIndexStore {
  if (!indexStore) throw new Error("SQLite index worker is not initialized");
  return indexStore;
}

function requireOwnerId(requestOwnerId?: string): string {
  if (!indexOwnerId) throw new Error("SQLite index worker is not initialized");
  if (requestOwnerId !== undefined && requestOwnerId !== indexOwnerId) {
    throw new Error("SQLite index worker owner mismatch");
  }
  return indexOwnerId;
}

function ensureWriter(requestOwnerId?: string): { store: SqliteIndexStore; ownerId: string } {
  const store = requireStore();
  const ownerId = requireOwnerId(requestOwnerId);
  if (!store.acquireWriterLease(ownerId, WRITER_LEASE_TTL_MS)) {
    throw new Error("SQLite index worker is read-only because another writer holds the lease");
  }
  return { store, ownerId };
}

function postResponse(response: SqliteWorkerResponse): void {
  workerPort.postMessage(response);
}
