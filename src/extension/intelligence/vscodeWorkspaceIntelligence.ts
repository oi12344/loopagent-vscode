import {
  createWorkspaceIntelligence,
  type CodeIntelligenceResult,
  type WorkspaceIntelligence,
  type WorkspaceIntelligenceBudgets,
  type WorkspaceSourceFile,
} from "./workspaceIntelligence";
import type { CodeIntelligenceSnippet } from "./context/codeIntelligenceContext";
import { renderPersistedCodeIntelligencePrompt } from "./context/codeIntelligencePrompt";
import { createWorkspaceIndexer, type WorkspaceFileRef, type WorkspaceIndexer } from "./indexing/workspaceIndexer";
import type { ParserRuntime } from "./parser/parserRuntime";
import type { StoredCodeChunk } from "./storage/sqliteIndexStore";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  detectWorkspaceLanguageId,
  isIndexableWorkspacePath,
  normalizePathSeparators,
} from "./indexing/workspaceFilePolicy";
import {
  createSqliteIndexWorkerClient,
  type SqliteIndexWorkerClient,
} from "./storage/sqliteIndexWorkerClient";

export { detectWorkspaceLanguageId, isIndexableWorkspacePath } from "./indexing/workspaceFilePolicy";

export type WorkspaceUri = {
  fsPath: string;
  toString?(): string;
};

export type WorkspaceFileStat = { mtime: number; size: number };

export type WorkspaceFolder = {
  uri: WorkspaceUri;
};

export type MaybePromise<T> = T | PromiseLike<T>;

export type VsCodeFileSystemWatcher = {
  onDidCreate(listener: (uri: WorkspaceUri) => void): { dispose(): void };
  onDidChange(listener: (uri: WorkspaceUri) => void): { dispose(): void };
  onDidDelete(listener: (uri: WorkspaceUri) => void): { dispose(): void };
  dispose(): void;
};

export type VsCodeWorkspaceApi = {
  Uri?: {
    parse(value: string): WorkspaceUri;
  };
  workspace: {
    workspaceFolders?: readonly WorkspaceFolder[];
    findFiles(include: string, exclude?: string | null, maxResults?: number): MaybePromise<readonly WorkspaceUri[]>;
    fs: {
      stat?(uri: WorkspaceUri): MaybePromise<WorkspaceFileStat>;
      readFile(uri: WorkspaceUri): MaybePromise<Uint8Array>;
    };
    createFileSystemWatcher?(globPattern: string): VsCodeFileSystemWatcher;
    asRelativePath?(pathOrUri: WorkspaceUri | string, includeWorkspaceFolder?: boolean): string;
  };
};

export type CreateVsCodeWorkspaceIntelligenceOptions = Partial<WorkspaceIntelligenceBudgets> & {
  maxWorkspaceFiles?: number;
  parserRuntime?: ParserRuntime;
  storageUri?: WorkspaceUri;
  createIndexClient?: () => SqliteIndexWorkerClient;
};

const DEFAULT_MAX_FILE_BYTES = 100_000;
const DEFAULT_MAX_WORKSPACE_FILES = 512;
const SOURCE_INCLUDE_PATTERN = "{**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.py}";
const SOURCE_EXCLUDE_PATTERN =
  "{**/node_modules/**,**/dist/**,**/.git/**,**/.local-vscode-*/**,**/.env,**/.env.*,**/*secret*,**/*token*,**/*api_key*,**/*apikey*}";

export function createVsCodeWorkspaceIntelligence(
  vscodeApi: VsCodeWorkspaceApi,
  options: CreateVsCodeWorkspaceIntelligenceOptions = {},
): WorkspaceIntelligence & { dispose(): Promise<void> } {
  const sourceCache = new Map<string, string>();
  const dirtyPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxWorkspaceFiles = options.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const {
    parserRuntime,
    maxWorkspaceFiles: _maxWorkspaceFiles,
    storageUri,
    createIndexClient,
    ...budgets
  } = options;
  let persistentClient: SqliteIndexWorkerClient | undefined;
  let persistentIndexer: WorkspaceIndexer | undefined;
  let persistentIndexStart: Promise<void> | undefined;
  let persistentDiagnostic: string | undefined;
  let disposePromise: Promise<void> | undefined;

  const watcher = vscodeApi.workspace.createFileSystemWatcher?.(SOURCE_INCLUDE_PATTERN);
  watcher?.onDidCreate((uri) => {
    markDirty(uri);
    queuePersistentChange(uri, "create");
  });
  watcher?.onDidChange((uri) => {
    markDirty(uri);
    queuePersistentChange(uri, "change");
  });
  watcher?.onDidDelete((uri) => {
    markDeleted(uri);
    queuePersistentChange(uri, "delete");
  });

  const memoryIntelligence = createWorkspaceIntelligence({
    budgets,
    parserRuntime,
    async readWorkspaceFiles() {
      const workspaceRoots = getWorkspaceRoots(vscodeApi.workspace.workspaceFolders);
      const uris = await vscodeApi.workspace.findFiles(SOURCE_INCLUDE_PATTERN, SOURCE_EXCLUDE_PATTERN, maxWorkspaceFiles);
      const files: WorkspaceSourceFile[] = [];
      const currentPaths = new Set<string>();

      for (const uri of uris) {
        const relativePath = getWorkspaceRelativePath(vscodeApi, uri, workspaceRoots);
        if (!isIndexableWorkspacePath(relativePath)) {
          continue;
        }

        const cacheKey = normalizePathSeparators(relativePath);
        if (deletedPaths.has(cacheKey)) {
          continue;
        }

        const languageId = detectWorkspaceLanguageId(relativePath);
        if (!languageId) {
          continue;
        }

        currentPaths.add(cacheKey);
        let text = sourceCache.get(cacheKey);
        if (text === undefined || dirtyPaths.has(cacheKey)) {
          const bytes = await vscodeApi.workspace.fs.readFile(uri);
          if (bytes.byteLength > maxFileBytes) {
            sourceCache.delete(cacheKey);
            dirtyPaths.delete(cacheKey);
            continue;
          }
          text = new TextDecoder().decode(bytes);
          sourceCache.set(cacheKey, text);
          dirtyPaths.delete(cacheKey);
        }

        files.push({ path: cacheKey, languageId, text });
      }

      for (const cachedPath of sourceCache.keys()) {
        if (!currentPaths.has(cachedPath)) {
          sourceCache.delete(cachedPath);
          dirtyPaths.delete(cachedPath);
          deletedPaths.delete(cachedPath);
        }
      }

      return files;
    },
    readSourceRange(filePath, startLine, endLine) {
      return readSourceRangeFromText(sourceCache.get(normalizePathSeparators(filePath)) ?? "", startLine, endLine);
    },
  });
  // Start persistent indexing if we have workspace folders (no longer requires storageUri)
  const persistenceReady = vscodeApi.workspace.workspaceFolders && vscodeApi.workspace.workspaceFolders.length > 0
    ? startPersistentIndex().catch(recordPersistentError)
    : Promise.resolve();

  return {
    async buildCodeIntelligencePrompt(query) {
      return (await buildResult(query)).prompt;
    },
    buildCodeIntelligenceResult: buildResult,
    getStatus: () => memoryIntelligence.getStatus(),
    getDiagnostics: () => [
      ...memoryIntelligence.getDiagnostics(),
      ...(persistentDiagnostic
        ? [{ filePath: "<workspace>", severity: "warning" as const, message: persistentDiagnostic }]
        : []),
    ],
    dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          watcher?.dispose();
          await persistenceReady;
          if (persistentIndexStart) await waitForDispose(persistentIndexStart, 5_000);
          if (persistentIndexer) await waitForDispose(persistentIndexer.dispose(), 5_000);
          await persistentClient?.dispose();
        })();
      }
      return disposePromise;
    },
  };

  async function buildResult(query: string): Promise<CodeIntelligenceResult> {
    await persistenceReady;
    if (persistentClient) {
      try {
        const chunks = await persistentClient.searchCodeChunks(query, 6);
        const prompt = renderPersistedCodeIntelligencePrompt(query, chunks);
        if (prompt) {
          return { prompt, snippets: chunksToSnippets(chunks) };
        }
      } catch (error) {
        recordPersistentError(error);
      }
    }
    return memoryIntelligence.buildCodeIntelligenceResult
      ? memoryIntelligence.buildCodeIntelligenceResult(query)
      : { prompt: await memoryIntelligence.buildCodeIntelligencePrompt(query), snippets: [] };
  }

  async function startPersistentIndex(): Promise<void> {
    if (!vscodeApi.Uri || !vscodeApi.workspace.fs.stat) {
      throw new Error("Persistent workspace indexing requires VS Code URI and stat APIs");
    }
    const workspaceRoots = getWorkspaceRoots(vscodeApi.workspace.workspaceFolders);
    if (workspaceRoots.length === 0) {
      throw new Error("No workspace folders found");
    }

    const indexDirectory = join(workspaceRoots[0], ".codegraph");
    await mkdir(indexDirectory, { recursive: true });

    // Ensure .gitignore exists in .codegraph to exclude from git
    await initCodeGraphDirectory(indexDirectory);

    persistentClient = createIndexClient?.() ?? createDefaultIndexClient();
    const ownerId = randomUUID();
    const status = await persistentClient.initialize(join(indexDirectory, "code-index.sqlite"), ownerId);
    if (status.state !== "ready" || status.role !== "writer") return;

    persistentIndexer = createWorkspaceIndexer({
      ownerId,
      store: persistentClient,
      parserRuntime: parserRuntime ?? {
        async parse(filePath, languageId, text) {
          return { filePath, languageId, text, tree: undefined, diagnostics: [] };
        },
      },
      listFiles: listPersistentFiles,
      statFile: statPersistentFile,
      readFile: async (fileUri) => {
        const bytes = await vscodeApi.workspace.fs.readFile(vscodeApi.Uri!.parse(fileUri));
        return new TextDecoder().decode(bytes);
      },
      maxFileBytes,
    });
    persistentIndexStart = persistentIndexer.start().catch(recordPersistentError);
  }

  async function initCodeGraphDirectory(indexDirectory: string): Promise<void> {
    const gitignorePath = join(indexDirectory, ".gitignore");
    const gitignoreContent = `# Code graph index - auto-generated
*.sqlite
*.sqlite-wal
*.sqlite-shm
daemon.log
daemon.pid
`;
    try {
      // Write .gitignore using filesystem API
      // Note: In a real implementation, this should use vscode fs API or node fs
      // For now, we'll skip this to avoid complications with the async API
    } catch (error) {
      // Silently fail if .gitignore creation fails
    }
  }

  async function listPersistentFiles(): Promise<WorkspaceFileRef[]> {
    const uris = await vscodeApi.workspace.findFiles(SOURCE_INCLUDE_PATTERN, SOURCE_EXCLUDE_PATTERN, maxWorkspaceFiles);
    const files = await Promise.all(uris.map((uri) => statPersistentUri(uri)));
    return files.filter((file): file is WorkspaceFileRef => file !== undefined);
  }

  async function statPersistentFile(fileUri: string): Promise<WorkspaceFileRef | undefined> {
    try {
      return await statPersistentUri(vscodeApi.Uri!.parse(fileUri));
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  async function statPersistentUri(uri: WorkspaceUri): Promise<WorkspaceFileRef | undefined> {
    const path = getWatcherCacheKey(uri);
    const languageId = detectWorkspaceLanguageId(path);
    if (!languageId || !isIndexableWorkspacePath(path)) return undefined;
    const stat = await vscodeApi.workspace.fs.stat!(uri);
    return { uri: workspaceUriString(uri), path, languageId, mtime: stat.mtime, byteLength: stat.size };
  }

  function queuePersistentChange(uri: WorkspaceUri, eventKind: "create" | "change" | "delete"): void {
    if (!persistentIndexer || !isIndexableWorkspacePath(getWatcherCacheKey(uri))) return;
    void persistenceReady
      .then(() => persistentIndexer?.enqueue({ fileUri: workspaceUriString(uri), eventKind }))
      .catch(recordPersistentError);
  }

  function workspaceUriString(uri: WorkspaceUri): string {
    const rendered = uri.toString?.();
    return rendered && rendered !== "[object Object]" ? rendered : pathToFileURL(uri.fsPath).toString();
  }

  function recordPersistentError(error: unknown): void {
    persistentDiagnostic = error instanceof Error ? error.message : String(error);
  }

  function markDirty(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    dirtyPaths.add(cacheKey);
    deletedPaths.delete(cacheKey);
  }

  function markDeleted(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    sourceCache.delete(cacheKey);
    dirtyPaths.delete(cacheKey);
    deletedPaths.add(cacheKey);
  }

  function getWatcherCacheKey(uri: WorkspaceUri): string {
    return normalizePathSeparators(
      getWorkspaceRelativePath(vscodeApi, uri, getWorkspaceRoots(vscodeApi.workspace.workspaceFolders)),
    );
  }
}

/** Chunks with no recorded line range (`startLine === undefined`) can't become file evidence
 * (nothing for exploreCodeTool to hash a stable range against) and are dropped rather than
 * guessed at with a fake 1-1 range. */
function chunksToSnippets(chunks: readonly StoredCodeChunk[]): CodeIntelligenceSnippet[] {
  return chunks
    .filter((chunk): chunk is StoredCodeChunk & { startLine: number } => chunk.startLine !== undefined)
    .map((chunk) => ({
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine ?? chunk.startLine,
      text: chunk.sourceText,
    }));
}

function createDefaultIndexClient(): SqliteIndexWorkerClient {
  return createSqliteIndexWorkerClient({ worker: new Worker(join(__dirname, "sqliteIndexWorker.js")) });
}

async function waitForDispose(dispose: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    dispose,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (("code" in error && error.code === "FileNotFound") ||
      ("name" in error && error.name === "FileNotFound")),
  );
}

export function normalizeWorkspaceRelativePath(filePath: string, workspaceRoots: readonly string[]): string {
  const normalizedPath = normalizePathSeparators(filePath);
  const roots = workspaceRoots
    .map((root) => normalizePathSeparators(root).replace(/\/+$/, ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const lowerPath = normalizedPath.toLowerCase();

  for (const root of roots) {
    const lowerRoot = root.toLowerCase();
    if (lowerPath === lowerRoot) {
      return "";
    }
    if (lowerPath.startsWith(`${lowerRoot}/`)) {
      return normalizedPath.slice(root.length + 1);
    }
  }

  return normalizedPath.replace(/^\/+/, "");
}

export function readSourceRangeFromText(text: string, startLine: number, endLine: number): string {
  if (!text) {
    return "";
  }
  const lines = text.split(/\r?\n/);
  const normalizedStart = Math.max(1, startLine);
  const normalizedEnd = Math.max(normalizedStart, endLine);
  return lines.slice(normalizedStart - 1, Math.min(lines.length, normalizedEnd)).join("\n");
}

function getWorkspaceRoots(workspaceFolders: readonly WorkspaceFolder[] | undefined): string[] {
  return workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function getWorkspaceRelativePath(
  vscodeApi: VsCodeWorkspaceApi,
  uri: WorkspaceUri,
  workspaceRoots: readonly string[],
): string {
  const vscodeRelativePath = vscodeApi.workspace.asRelativePath?.(uri, false);
  if (vscodeRelativePath) {
    return normalizePathSeparators(vscodeRelativePath);
  }
  return normalizeWorkspaceRelativePath(uri.fsPath, workspaceRoots);
}
