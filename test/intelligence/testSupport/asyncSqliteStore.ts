import type { SqliteIndexStore } from "../../../src/extension/intelligence/storage/sqliteIndexStore";

export function createAsyncSqliteStore(store: SqliteIndexStore, ownerId: string) {
  return {
    getStatus: async () => ({
      state: "ready" as const,
      role: "writer" as const,
      schemaVersion: 1,
      capabilities: { sqlite: true, wal: true, foreignKeys: true, fts5: true },
    }),
    listIndexedFiles: async () => store.listIndexedFiles(),
    enqueueChanges: async (changes: Parameters<SqliteIndexStore["enqueueChanges"]>[1]) => {
      store.enqueueChanges(ownerId, changes);
    },
    claimNextJob: async (claimOwnerId: string) => store.claimNextJob(claimOwnerId),
    applyFileSnapshot: async (snapshot: Parameters<SqliteIndexStore["applyFileSnapshot"]>[1]) => {
      store.applyFileSnapshot(ownerId, snapshot);
    },
    indexNodeSearchTokens: async (snapshot: Parameters<SqliteIndexStore["indexNodeSearchTokens"]>[1]) => {
      store.indexNodeSearchTokens(ownerId, snapshot);
    },
    updateFileMetadata: async (update: Parameters<SqliteIndexStore["updateFileMetadata"]>[1]) => {
      store.updateFileMetadata(ownerId, update);
    },
    removeFile: async (fileUri: string) => {
      store.removeFile(ownerId, fileUri);
    },
    completeJob: async (claim: Parameters<SqliteIndexStore["completeJob"]>[1]) => {
      store.completeJob(ownerId, claim);
    },
    failJob: async (claim: Parameters<SqliteIndexStore["failJob"]>[1], error: string) => {
      store.failJob(ownerId, claim, error);
    },
  };
}
