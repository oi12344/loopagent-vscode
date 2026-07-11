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

let closing = false;
let requestQueue = Promise.resolve();
let indexDatabase: OpenIndexDatabaseResult | undefined;
let indexStore: SqliteIndexStore | undefined;

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
      indexDatabase = undefined;
      indexStore = undefined;
      previousDatabase?.close();
      const capabilities = probeSqliteCapabilities(request.databasePath);
      indexDatabase = openIndexDatabase(request.databasePath);
      indexStore = new SqliteIndexStore(indexDatabase.database);
      return { schemaVersion: 1, capabilities };
    }
    case "enqueueChanges":
      requireStore().enqueueChanges(request.changes);
      return undefined;
    case "getPendingJobs":
      return requireStore().listPendingJobs();
    case "claimNextJob":
      return requireStore().claimNextJob(request.ownerId);
    case "completeJob":
      requireStore().completeJob(request.claim);
      return undefined;
    case "failJob":
      requireStore().failJob(request.claim, request.error);
      return undefined;
    case "getStatus":
      return { state: "idle" };
    case "dispose":
      indexDatabase?.close();
      indexDatabase = undefined;
      indexStore = undefined;
      return undefined;
  }
}

function requireStore(): SqliteIndexStore {
  if (!indexStore) throw new Error("SQLite index worker is not initialized");
  return indexStore;
}

function postResponse(response: SqliteWorkerResponse): void {
  workerPort.postMessage(response);
}
