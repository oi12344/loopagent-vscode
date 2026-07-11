import type { ClaimedIndexJob, IndexChange, StoredIndexJob } from "./sqliteIndexStore";
import type { IndexWorkerStatus } from "./sqliteIndexWorkerRuntime";

export type SqliteWorkerRequest =
  | { id: number; kind: "probe"; databasePath: string }
  | { id: number; kind: "initialize"; databasePath: string; ownerId: string }
  | { id: number; kind: "enqueueChanges"; changes: readonly IndexChange[] }
  | { id: number; kind: "getPendingJobs" }
  | { id: number; kind: "claimNextJob"; ownerId: string }
  | { id: number; kind: "completeJob"; claim: ClaimedIndexJob }
  | { id: number; kind: "failJob"; claim: ClaimedIndexJob; error: string }
  | { id: number; kind: "getStatus" }
  | { id: number; kind: "dispose" };

export type SqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

export type SqliteWorkerEvent = { kind: "status"; status: IndexWorkerStatus };
export type SqliteWorkerMessage = SqliteWorkerResponse | SqliteWorkerEvent;

export type { ClaimedIndexJob, IndexChange, IndexWorkerStatus, StoredIndexJob };
