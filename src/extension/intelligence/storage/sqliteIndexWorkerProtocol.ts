import type {
  ClaimedIndexJob,
  FileMetadataUpdate,
  IndexChange,
  StoredFileMetadata,
  StoredIndexJob,
  StoredCodeChunk,
  SearchNodeResult,
} from "./sqliteIndexStore";
import type { IndexWorkerStatus } from "./sqliteIndexWorkerRuntime";
import type { ExtractionSnapshot } from "./indexTypes";

export type SqliteWorkerRequest =
  | { id: number; kind: "probe"; databasePath: string }
  | { id: number; kind: "initialize"; databasePath: string; ownerId: string }
  | { id: number; kind: "enqueueChanges"; changes: readonly IndexChange[] }
  | { id: number; kind: "applyFileSnapshot"; snapshot: ExtractionSnapshot }
  | { id: number; kind: "indexNodeSearchTokens"; snapshot: ExtractionSnapshot }
  | { id: number; kind: "listIndexedFiles" }
  | { id: number; kind: "updateFileMetadata"; update: FileMetadataUpdate }
  | { id: number; kind: "removeFile"; fileUri: string }
  | { id: number; kind: "searchCodeChunks"; query: string; limit: number }
  | { id: number; kind: "searchNodes"; query: string; limit: number }
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

export type {
  ClaimedIndexJob,
  FileMetadataUpdate,
  IndexChange,
  IndexWorkerStatus,
  StoredFileMetadata,
  StoredIndexJob,
  StoredCodeChunk,
  SearchNodeResult,
};
