import { parentPort } from "node:worker_threads";

import { openIndexDatabase } from "./indexDatabase";
import { probeSqliteCapabilities } from "./sqliteCapabilities";
import { SqliteIndexStore } from "./sqliteIndexStore";
import type { SqliteWorkerRequest, SqliteWorkerResponse } from "./sqliteIndexWorkerProtocol";
import { createSqliteIndexWorkerRuntime } from "./sqliteIndexWorkerRuntime";

if (!parentPort) throw new Error("SQLite index worker requires a parent port");
const workerPort = parentPort;

const runtime = createSqliteIndexWorkerRuntime({
  ttlMs: 30_000,
  staleJobMs: 60_000,
  probe: probeSqliteCapabilities,
  openDatabase: openIndexDatabase,
  createStore: (database) => new SqliteIndexStore(database),
  onStatus: (status) => workerPort.postMessage({ kind: "status", status }),
});

let closing = false;
let requestQueue = Promise.resolve();

workerPort.on("message", (request: SqliteWorkerRequest) => {
  requestQueue = requestQueue.then(() => {
    if (!closing) handleRequest(request);
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
    case "initialize":
      return runtime.initialize(request.databasePath, request.ownerId);
    case "enqueueChanges":
      return runtime.enqueueChanges(request.changes);
    case "applyFileSnapshot":
      return runtime.applyFileSnapshot(request.snapshot);
    case "indexNodeSearchTokens":
      return runtime.indexNodeSearchTokens(request.snapshot);
    case "listIndexedFiles":
      return runtime.listIndexedFiles();
    case "getIndexedFile":
      return runtime.getIndexedFile(request.fileUri);
    case "updateFileMetadata":
      return runtime.updateFileMetadata(request.update);
    case "removeFile":
      return runtime.removeFile(request.fileUri);
    case "searchCodeChunks":
      return runtime.searchCodeChunks(request.query, request.limit);
    case "searchNodes":
      return runtime.searchNodes(request.query, request.limit);
    case "getPendingJobs":
      return runtime.getPendingJobs();
    case "claimNextJob":
      return runtime.claimNextJob(request.ownerId);
    case "completeJob":
      return runtime.completeJob(request.claim);
    case "failJob":
      return runtime.failJob(request.claim, request.error);
    case "getStatus":
      return runtime.getStatus();
    case "dispose":
      return runtime.dispose();
  }
}

function postResponse(response: SqliteWorkerResponse): void {
  workerPort.postMessage(response);
}
