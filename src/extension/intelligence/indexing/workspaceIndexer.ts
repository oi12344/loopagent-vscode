import { createHash } from "node:crypto";

import { createJavaAdapter } from "../languages/javaAdapter";
import { createPythonAdapter } from "../languages/pythonAdapter";
import { createTypeScriptAdapter } from "../languages/typescriptAdapter";
import type { ParserRuntime } from "../parser/parserRuntime";
import type { SqliteIndexWorkerClient } from "../storage/sqliteIndexWorkerClient";
import type { IndexChange } from "../storage/sqliteIndexStore";
import { buildExtractionSnapshot } from "./extractionSnapshot";
import { isIndexableWorkspacePath } from "./workspaceFilePolicy";

const EXTRACTOR_VERSION = 2;
const CHUNKER_VERSION = 2;

export type WorkspaceFileRef = {
  uri: string;
  path: string;
  languageId: string;
  mtime: number;
  byteLength: number;
};

type WorkspaceIndexerStore = Pick<
  SqliteIndexWorkerClient,
  | "getStatus"
  | "listIndexedFiles"
  | "getIndexedFile"
  | "enqueueChanges"
  | "claimNextJob"
  | "applyFileSnapshot"
  | "indexNodeSearchTokens"
  | "updateFileMetadata"
  | "removeFile"
  | "completeJob"
  | "failJob"
>;

type WorkspaceIndexerDependencies = {
  ownerId: string;
  store: WorkspaceIndexerStore;
  parserRuntime: ParserRuntime;
  listFiles(): Promise<WorkspaceFileRef[]>;
  statFile(fileUri: string): Promise<WorkspaceFileRef | undefined>;
  readFile(fileUri: string): Promise<string>;
  maxFileBytes: number;
};

export type WorkspaceIndexer = {
  start(): Promise<void>;
  enqueue(change: IndexChange): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
};

export function createWorkspaceIndexer(deps: WorkspaceIndexerDependencies): WorkspaceIndexer {
  const adapters = [createTypeScriptAdapter(), createPythonAdapter(), createJavaAdapter()];
  let disposed = false;
  let started = false;
  let drainPromise: Promise<void> | undefined;
  let drainAgain = false;

  async function runJobs(): Promise<void> {
    do {
      drainAgain = false;
      while (!disposed) {
        const claim = await deps.store.claimNextJob(deps.ownerId);
        if (!claim) break;
        try {
          await processFile(claim.fileUri);
          await deps.store.completeJob(claim);
        } catch (error) {
          await deps.store.failJob(claim, error instanceof Error ? error.message : String(error));
        }
      }
    } while (drainAgain && !disposed);
  }

  async function processFile(fileUri: string): Promise<void> {
    const file = await deps.statFile(fileUri);
    if (!file || !isIndexableWorkspacePath(file.path) || file.byteLength > deps.maxFileBytes) {
      await deps.store.removeFile(fileUri);
      return;
    }

    const adapter = adapters.find((candidate) => candidate.languageIds.includes(file.languageId));
    if (!adapter) {
      await deps.store.removeFile(fileUri);
      return;
    }

    const text = await deps.readFile(fileUri);
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > deps.maxFileBytes) {
      await deps.store.removeFile(fileUri);
      return;
    }
    const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
    const stored = await deps.store.getIndexedFile(fileUri);
    const metadata = {
      uri: fileUri,
      byteLength,
      mtime: file.mtime,
      extractorVersion: EXTRACTOR_VERSION,
      chunkerVersion: CHUNKER_VERSION,
    };
    if (
      stored?.contentHash === contentHash &&
      stored.extractorVersion === EXTRACTOR_VERSION &&
      stored.chunkerVersion === CHUNKER_VERSION
    ) {
      await deps.store.updateFileMetadata(metadata);
      return;
    }

    const parsed = await deps.parserRuntime.parse(file.path, file.languageId, text);
    try {
      const extracted = adapter.extract(parsed);
      const snapshot = buildExtractionSnapshot({
        fileUri,
        filePath: file.path,
        parsed,
        extraction: {
          ...extracted,
          diagnostics: [...parsed.diagnostics, ...extracted.diagnostics],
        },
      });
      await deps.store.applyFileSnapshot(snapshot);
      await deps.store.indexNodeSearchTokens(snapshot);
      await deps.store.updateFileMetadata(metadata);
    } finally {
      parsed.tree?.delete();
    }
  }

  return {
    async start() {
      if (started || disposed) return;
      started = true;
      const status = await deps.store.getStatus();
      if (status.state !== "ready" || status.role !== "writer") return;

      const files = (await deps.listFiles()).filter(
        (file) => isIndexableWorkspacePath(file.path) && file.byteLength <= deps.maxFileBytes,
      );
      const storedFiles = await deps.store.listIndexedFiles();
      const currentByUri = new Map(files.map((file) => [file.uri, file]));
      const storedByUri = new Map(storedFiles.map((file) => [file.uri, file]));
      const changes: IndexChange[] = [];

      for (const file of files) {
        const stored = storedByUri.get(file.uri);
        if (!stored) {
          changes.push({ fileUri: file.uri, eventKind: "create" });
        } else if (
          stored.extractorVersion !== EXTRACTOR_VERSION ||
          stored.chunkerVersion !== CHUNKER_VERSION
        ) {
          changes.push({ fileUri: file.uri, eventKind: "change" });
        } else if (stored.mtime !== file.mtime || stored.byteLength !== file.byteLength) {
          // mtime or byteLength changed - read file and check contentHash to avoid false rebuilds
          try {
            const text = await deps.readFile(file.uri);
            const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
            if (stored.contentHash !== contentHash) {
              changes.push({ fileUri: file.uri, eventKind: "change" });
            }
          } catch {
            // Read failed - treat as needing reindex
            changes.push({ fileUri: file.uri, eventKind: "change" });
          }
        }
      }
      for (const stored of storedFiles) {
        if (!currentByUri.has(stored.uri)) changes.push({ fileUri: stored.uri, eventKind: "delete" });
      }
      if (changes.length > 0) await deps.store.enqueueChanges(changes);
      await this.drain();
    },
    async enqueue(change) {
      if (disposed) throw new Error("Workspace indexer disposed");
      await deps.store.enqueueChanges([change]);
      await this.drain();
    },
    drain() {
      if (drainPromise) {
        drainAgain = true;
        return drainPromise;
      }
      drainPromise = runJobs().finally(() => {
        drainPromise = undefined;
      });
      return drainPromise;
    },
    async dispose() {
      disposed = true;
      await drainPromise;
    },
  };
}
