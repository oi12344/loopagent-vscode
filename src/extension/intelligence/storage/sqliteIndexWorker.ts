import { parentPort } from "node:worker_threads";

import { probeSqliteCapabilities } from "./sqliteCapabilities";
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
    case "getStatus":
      return { state: "idle" };
    case "dispose":
      return undefined;
  }
}

function postResponse(response: SqliteWorkerResponse): void {
  workerPort.postMessage(response);
}
