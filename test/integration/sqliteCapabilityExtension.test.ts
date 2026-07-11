import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

import {
  createSqliteIndexWorkerClient,
  type SqliteIndexWorkerClient,
} from "../../src/extension/intelligence/storage/sqliteIndexWorkerClient";

export async function run(): Promise<void> {
  console.log(`[sqlite-probe] Extension Host Node ${process.version}`);

  let directory: string | undefined;
  let worker: Worker | undefined;
  let client: SqliteIndexWorkerClient | undefined;

  try {
    directory = await mkdtemp(path.join(tmpdir(), "loopagent-sqlite-probe-"));
    const databasePath = path.join(directory, "probe.sqlite");
    const workerPath = path.resolve(__dirname, "..", "sqliteIndexWorker.js");

    worker = new Worker(workerPath);
    client = createSqliteIndexWorkerClient({ worker });

    const capabilities = await client.probe(databasePath);
    assert.deepEqual(capabilities, {
      sqlite: true,
      wal: true,
      foreignKeys: true,
      fts5: true,
    });
    console.log(
      `[sqlite-probe] capabilities sqlite=${capabilities.sqlite} wal=${capabilities.wal} foreignKeys=${capabilities.foreignKeys} fts5=${capabilities.fts5}`,
    );
    await client.initialize(databasePath, "sqlite-probe-owner");
    await client.enqueueChanges([{ fileUri: "file:///probe.ts", eventKind: "change" }]);
    const pendingJobs = await client.getPendingJobs();
    assert.equal(pendingJobs.length, 1);
    assert.equal(pendingJobs[0]?.fileUri, "file:///probe.ts");
    assert.equal(pendingJobs[0]?.status, "pending");
    console.log("[sqlite-probe] initialized worker and persisted one pending job");
  } finally {
    try {
      if (client) {
        await client.dispose();
      } else if (worker) {
        await worker.terminate();
      }
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
