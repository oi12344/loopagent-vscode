import type { SqliteCapabilities } from "./sqliteCapabilities";
import type { OpenIndexDatabaseResult } from "./indexDatabase";
import type {
  ClaimedIndexJob,
  FileMetadataUpdate,
  IndexChange,
  SqliteIndexStore,
  StoredFileMetadata,
  StoredIndexJob,
  StoredCodeChunk,
} from "./sqliteIndexStore";
import type { ExtractionSnapshot } from "./indexTypes";

export type IndexWorkerStatus = {
  state: "initializing" | "ready" | "failed" | "closed";
  role: "writer" | "read_only";
  schemaVersion: number;
  capabilities: SqliteCapabilities;
};

export type SqliteWorkerStore = Pick<
  SqliteIndexStore,
  | "acquireWriterLease"
  | "renewWriterLease"
  | "releaseWriterLease"
  | "recoverInterruptedJobs"
  | "enqueueChanges"
  | "applyFileSnapshot"
  | "listIndexedFiles"
  | "updateFileMetadata"
  | "removeFile"
  | "searchCodeChunks"
  | "listPendingJobs"
  | "claimNextJob"
  | "completeJob"
  | "failJob"
>;

export type SqliteIndexWorkerRuntime = {
  initialize(databasePath: string, ownerId: string): IndexWorkerStatus;
  getStatus(): IndexWorkerStatus;
  enqueueChanges(changes: readonly IndexChange[]): void;
  applyFileSnapshot(snapshot: ExtractionSnapshot): void;
  listIndexedFiles(): StoredFileMetadata[];
  updateFileMetadata(update: FileMetadataUpdate): void;
  removeFile(fileUri: string): void;
  searchCodeChunks(query: string, limit: number): StoredCodeChunk[];
  getPendingJobs(): StoredIndexJob[];
  claimNextJob(ownerId: string): ClaimedIndexJob | undefined;
  completeJob(claim: ClaimedIndexJob): void;
  failJob(claim: ClaimedIndexJob, error: string): void;
  dispose(): void;
};

type RuntimeDependencies = {
  ttlMs: number;
  staleJobMs: number;
  probe(databasePath: string): SqliteCapabilities;
  openDatabase(databasePath: string): OpenIndexDatabaseResult;
  createStore(database: OpenIndexDatabaseResult["database"]): SqliteWorkerStore;
  onStatus?(status: IndexWorkerStatus): void;
};

const EMPTY_CAPABILITIES: SqliteCapabilities = {
  sqlite: false,
  wal: false,
  foreignKeys: false,
  fts5: false,
};

export function createSqliteIndexWorkerRuntime(deps: RuntimeDependencies): SqliteIndexWorkerRuntime {
  let status: IndexWorkerStatus = createStatus("closed", "read_only", 0, EMPTY_CAPABILITIES);
  let database: OpenIndexDatabaseResult | undefined;
  let store: SqliteWorkerStore | undefined;
  let ownerId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function publish(next: IndexWorkerStatus): void {
    status = next;
    deps.onStatus?.({ ...next, capabilities: { ...next.capabilities } });
  }

  function scheduleTick(): void {
    clearTimer();
    if (status.state !== "ready") return;
    timer = setTimeout(tick, Math.max(1, Math.floor(deps.ttlMs / 3)));
  }

  function tick(): void {
    timer = undefined;
    if (status.state !== "ready" || !store || !ownerId) return;
    if (status.role === "writer") {
      let renewed = false;
      try {
        renewed = store.renewWriterLease(ownerId, deps.ttlMs);
        if (renewed) store.recoverInterruptedJobs(ownerId, { staleAfterMs: deps.staleJobMs });
      } catch {
        renewed = false;
      }
      if (!renewed) publish(createStatus("ready", "read_only", status.schemaVersion, status.capabilities));
    } else {
      tryBecomeWriter();
    }
    scheduleTick();
  }

  function tryBecomeWriter(): boolean {
    if (!store || !ownerId) return false;
    try {
      if (!store.acquireWriterLease(ownerId, deps.ttlMs)) return false;
      store.recoverInterruptedJobs(ownerId, { staleAfterMs: deps.staleJobMs });
      publish(createStatus("ready", "writer", 1, status.capabilities));
      return true;
    } catch {
      try {
        store.releaseWriterLease(ownerId);
      } catch {
        // Keep the runtime read-only; the next bounded retry will re-evaluate the lease.
      }
      return false;
    }
  }

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function releaseAndClose(): void {
    clearTimer();
    const currentStore = store;
    const currentOwner = ownerId;
    const currentDatabase = database;
    store = undefined;
    ownerId = undefined;
    database = undefined;
    try {
      if (currentStore && currentOwner) currentStore.releaseWriterLease(currentOwner);
    } finally {
      currentDatabase?.close();
    }
  }

  function requireStore(): SqliteWorkerStore {
    if (!store) throw new Error("SQLite index worker is not initialized");
    return store;
  }

  function requireOwner(requestOwnerId?: string): string {
    if (!ownerId) throw new Error("SQLite index worker is not initialized");
    if (requestOwnerId !== undefined && requestOwnerId !== ownerId) {
      throw new Error("SQLite index worker owner mismatch");
    }
    return ownerId;
  }

  function runWriter<T>(operation: (activeStore: SqliteWorkerStore, activeOwner: string) => T): T {
    if (status.state !== "ready" || status.role !== "writer") {
      throw new Error("SQLite index worker is read-only");
    }
    const activeStore = requireStore();
    const activeOwner = requireOwner();
    try {
      return operation(activeStore, activeOwner);
    } catch (error) {
      if (error instanceof Error && /writer lease/i.test(error.message)) {
        publish(createStatus("ready", "read_only", status.schemaVersion, status.capabilities));
      }
      throw error;
    }
  }

  return {
    initialize(databasePath, requestedOwnerId) {
      let openedDatabase: OpenIndexDatabaseResult | undefined;
      try {
        releaseAndClose();
        publish(createStatus("initializing", "read_only", 0, EMPTY_CAPABILITIES));
        const capabilities = deps.probe(databasePath);
        openedDatabase = deps.openDatabase(databasePath);
        const openedStore = deps.createStore(openedDatabase.database);
        database = openedDatabase;
        store = openedStore;
        ownerId = requestedOwnerId;
        publish(createStatus("ready", "read_only", 1, capabilities));
        tryBecomeWriter();
        scheduleTick();
        return { ...status, capabilities: { ...status.capabilities } };
      } catch (error) {
        try {
          if (database) releaseAndClose();
          else openedDatabase?.close();
        } catch {
          // Preserve the initialization failure; close() already attempts release/checkpoint/close.
        } finally {
          publish(createStatus("failed", "read_only", 0, EMPTY_CAPABILITIES));
        }
        throw error;
      }
    },
    getStatus() {
      return { ...status, capabilities: { ...status.capabilities } };
    },
    enqueueChanges(changes) {
      runWriter((activeStore, activeOwner) => activeStore.enqueueChanges(activeOwner, changes));
    },
    applyFileSnapshot(snapshot) {
      runWriter((activeStore, activeOwner) => activeStore.applyFileSnapshot(activeOwner, snapshot));
    },
    listIndexedFiles() {
      return requireStore().listIndexedFiles();
    },
    updateFileMetadata(update) {
      runWriter((activeStore, activeOwner) => activeStore.updateFileMetadata(activeOwner, update));
    },
    removeFile(fileUri) {
      runWriter((activeStore, activeOwner) => activeStore.removeFile(activeOwner, fileUri));
    },
    searchCodeChunks(query, limit) {
      return requireStore().searchCodeChunks(query, limit);
    },
    getPendingJobs() {
      return requireStore().listPendingJobs();
    },
    claimNextJob(requestOwnerId) {
      requireOwner(requestOwnerId);
      return runWriter((activeStore, activeOwner) => activeStore.claimNextJob(activeOwner));
    },
    completeJob(claim) {
      runWriter((activeStore, activeOwner) => activeStore.completeJob(activeOwner, claim));
    },
    failJob(claim, error) {
      runWriter((activeStore, activeOwner) => activeStore.failJob(activeOwner, claim, error));
    },
    dispose() {
      if (status.state === "closed") return;
      try {
        releaseAndClose();
      } finally {
        publish(createStatus("closed", "read_only", status.schemaVersion, status.capabilities));
      }
    },
  };
}

function createStatus(
  state: IndexWorkerStatus["state"],
  role: IndexWorkerStatus["role"],
  schemaVersion: number,
  capabilities: SqliteCapabilities,
): IndexWorkerStatus {
  return { state, role, schemaVersion, capabilities: { ...capabilities } };
}
