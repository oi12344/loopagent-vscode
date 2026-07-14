import type { SqliteCapabilities } from "./sqliteCapabilities";
import type { ExtractionSnapshot } from "./indexTypes";
import type {
  ClaimedIndexJob,
  FileMetadataUpdate,
  IndexChange,
  IndexWorkerStatus,
  StoredFileMetadata,
  StoredIndexJob,
  StoredCodeChunk,
  SqliteWorkerMessage,
  SqliteWorkerRequest,
  SqliteWorkerResponse,
} from "./sqliteIndexWorkerProtocol";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

type SqliteWorkerTransport = {
  postMessage(request: SqliteWorkerRequest): void;
  on(
    event: "message",
    listener: (response: SqliteWorkerMessage) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (exitCode: number) => void): unknown;
  terminate(): Promise<number>;
};

export type SqliteIndexWorkerClient = {
  probe(databasePath: string): Promise<SqliteCapabilities>;
  initialize(databasePath: string, ownerId: string): Promise<IndexWorkerStatus>;
  enqueueChanges(changes: readonly IndexChange[]): Promise<void>;
  applyFileSnapshot(snapshot: ExtractionSnapshot): Promise<void>;
  listIndexedFiles(): Promise<StoredFileMetadata[]>;
  updateFileMetadata(update: FileMetadataUpdate): Promise<void>;
  removeFile(fileUri: string): Promise<void>;
  searchCodeChunks(query: string, limit: number): Promise<StoredCodeChunk[]>;
  getPendingJobs(): Promise<StoredIndexJob[]>;
  claimNextJob(ownerId: string): Promise<ClaimedIndexJob | undefined>;
  completeJob(claim: ClaimedIndexJob): Promise<void>;
  failJob(claim: ClaimedIndexJob, error: string): Promise<void>;
  getStatus(): Promise<IndexWorkerStatus>;
  onDidChangeStatus(listener: (status: IndexWorkerStatus) => void): { dispose(): void };
  dispose(): Promise<void>;
};

export function createSqliteIndexWorkerClient({
  worker,
}: {
  worker: SqliteWorkerTransport;
}): SqliteIndexWorkerClient {
  return new DefaultSqliteIndexWorkerClient(worker);
}

class DefaultSqliteIndexWorkerClient implements SqliteIndexWorkerClient {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private stoppedError: Error | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly statusListeners = new Set<(status: IndexWorkerStatus) => void>();

  constructor(private readonly worker: SqliteWorkerTransport) {
    worker.on("message", this.handleResponse);
    worker.on("error", this.handleWorkerError);
    worker.on("exit", this.handleWorkerExit);
  }

  probe(databasePath: string): Promise<SqliteCapabilities> {
    return this.request((id) => ({ id, kind: "probe", databasePath }));
  }

  initialize(databasePath: string, ownerId: string): Promise<IndexWorkerStatus> {
    return this.request((id) => ({ id, kind: "initialize", databasePath, ownerId }));
  }

  enqueueChanges(changes: readonly IndexChange[]): Promise<void> {
    return this.request((id) => ({ id, kind: "enqueueChanges", changes }));
  }

  applyFileSnapshot(snapshot: ExtractionSnapshot): Promise<void> {
    return this.request((id) => ({ id, kind: "applyFileSnapshot", snapshot }));
  }

  listIndexedFiles(): Promise<StoredFileMetadata[]> {
    return this.request((id) => ({ id, kind: "listIndexedFiles" }));
  }

  updateFileMetadata(update: FileMetadataUpdate): Promise<void> {
    return this.request((id) => ({ id, kind: "updateFileMetadata", update }));
  }

  removeFile(fileUri: string): Promise<void> {
    return this.request((id) => ({ id, kind: "removeFile", fileUri }));
  }

  searchCodeChunks(query: string, limit: number): Promise<StoredCodeChunk[]> {
    return this.request((id) => ({ id, kind: "searchCodeChunks", query, limit }));
  }

  getPendingJobs(): Promise<StoredIndexJob[]> {
    return this.request((id) => ({ id, kind: "getPendingJobs" }));
  }

  claimNextJob(ownerId: string): Promise<ClaimedIndexJob | undefined> {
    return this.request((id) => ({ id, kind: "claimNextJob", ownerId }));
  }

  completeJob(claim: ClaimedIndexJob): Promise<void> {
    return this.request((id) => ({ id, kind: "completeJob", claim }));
  }

  failJob(claim: ClaimedIndexJob, error: string): Promise<void> {
    return this.request((id) => ({ id, kind: "failJob", claim, error }));
  }

  getStatus(): Promise<IndexWorkerStatus> {
    return this.request((id) => ({ id, kind: "getStatus" }));
  }

  onDidChangeStatus(listener: (status: IndexWorkerStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => this.statusListeners.delete(listener) };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    this.rejectAll(new Error("SQLite worker client disposed"));
    const disposeRequest = this.stoppedError
      ? Promise.reject<void>(this.stoppedError)
      : this.sendRequest<void>((id) => ({ id, kind: "dispose" }));
    this.disposePromise = disposeRequest
      .finally(() => this.worker.terminate())
      .then(() => undefined);
    return this.disposePromise;
  }

  private request<T>(
    createRequest: (id: number) => SqliteWorkerRequest,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("SQLite worker client disposed"));
    }
    if (this.stoppedError) {
      return Promise.reject(this.stoppedError);
    }

    return this.sendRequest(createRequest);
  }

  private sendRequest<T>(
    createRequest: (id: number) => SqliteWorkerRequest,
  ): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        this.worker.postMessage(createRequest(id));
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private readonly handleResponse = (response: SqliteWorkerMessage): void => {
    if ("kind" in response) {
      for (const listener of [...this.statusListeners]) {
        try {
          listener(response.status);
        } catch {
          // A consumer callback must not break other listeners or RPC response handling.
        }
      }
      return;
    }
    const pendingRequest = this.pendingRequests.get(response.id);
    if (!pendingRequest) {
      return;
    }

    this.pendingRequests.delete(response.id);
    if (response.ok) {
      pendingRequest.resolve(response.value);
      return;
    }
    pendingRequest.reject(new Error(response.error));
  };

  private readonly handleWorkerError = (error: Error): void => {
    this.stop(error);
  };

  private readonly handleWorkerExit = (exitCode: number): void => {
    this.stop(new Error(`SQLite worker exited with code ${exitCode}`));
  };

  private stop(error: Error): void {
    this.stoppedError ??= error;
    this.rejectAll(this.stoppedError);
  }

  private rejectAll(error: Error): void {
    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const pendingRequest of pendingRequests) {
      pendingRequest.reject(error);
    }
  }
}
