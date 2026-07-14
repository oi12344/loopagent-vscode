import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVsCodeWorkspaceIntelligence,
  detectWorkspaceLanguageId,
  isIndexableWorkspacePath,
  normalizeWorkspaceRelativePath,
  readSourceRangeFromText,
  type VsCodeWorkspaceApi,
} from "../../src/extension/intelligence/vscodeWorkspaceIntelligence";

type WorkspaceUri = { fsPath: string };

type FakeWatcher = {
  dispose: ReturnType<typeof vi.fn>;
  fireCreate(uri: WorkspaceUri): void;
  fireChange(uri: WorkspaceUri): void;
  fireDelete(uri: WorkspaceUri): void;
};

type FakeVsCodeWorkspaceApiOptions = {
  watcher?: FakeWatcher;
  onRead?: () => void;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("isIndexableWorkspacePath", () => {
  it("excludes generated, dependency, local debug, and sensitive paths", () => {
    expect(isIndexableWorkspacePath("src/extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules/react/index.js")).toBe(false);
    expect(isIndexableWorkspacePath("dist/extension.js")).toBe(false);
    expect(isIndexableWorkspacePath(".git/config")).toBe(false);
    expect(isIndexableWorkspacePath(".local-vscode-user-data/User/settings.json")).toBe(false);
    expect(isIndexableWorkspacePath(".env")).toBe(false);
    expect(isIndexableWorkspacePath(".env.local")).toBe(false);
    expect(isIndexableWorkspacePath("secrets/model.ts")).toBe(false);
    expect(isIndexableWorkspacePath("secrets/api-token.txt")).toBe(false);
    expect(isIndexableWorkspacePath("config/api_key.json")).toBe(false);
  });

  it("normalizes Windows paths before filtering", () => {
    expect(isIndexableWorkspacePath("src\\extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules\\react\\index.js")).toBe(false);
  });
});

describe("VS workspace helpers", () => {
  it("detects supported language ids from paths", () => {
    expect(detectWorkspaceLanguageId("src/extension.ts")).toBe("typescript");
    expect(detectWorkspaceLanguageId("src/App.tsx")).toBe("typescriptreact");
    expect(detectWorkspaceLanguageId("scripts/tool.js")).toBe("javascript");
    expect(detectWorkspaceLanguageId("scripts/tool.jsx")).toBe("javascriptreact");
    expect(detectWorkspaceLanguageId("tools/index.py")).toBe("python");
    expect(detectWorkspaceLanguageId("README.md")).toBeUndefined();
  });

  it("normalizes workspace relative paths", () => {
    expect(normalizeWorkspaceRelativePath("E:\\work\\repo\\src\\extension.ts", ["E:\\work\\repo"])).toBe(
      "src/extension.ts",
    );
    expect(normalizeWorkspaceRelativePath("/work/repo/src/extension.ts", ["/work/repo"])).toBe("src/extension.ts");
  });

  it("reads one-based source ranges", () => {
    expect(readSourceRangeFromText("a\nb\nc\nd", 2, 3)).toBe("b\nc");
    expect(readSourceRangeFromText("a\nb", -5, 99)).toBe("a\nb");
  });
});

describe("createVsCodeWorkspaceIntelligence", () => {
  it("starts persistent indexing on the existing watcher and disposes it once", async () => {
    const workspaceRoot = "E:\\work\\repo";
    const watcher = createFakeWatcher();
    const sourcePath = `${workspaceRoot}\\src\\modelAccess.ts`;
    const files = new Map([[sourcePath, "export function createDeepSeekProvider() {}"]]);
    const client = createFakeIndexClient();
    const storagePath = mkdtempSync(join(tmpdir(), "loopagent-vscode-index-"));
    temporaryDirectories.push(storagePath);
    const intelligence = createVsCodeWorkspaceIntelligence(
      createFakeVsCodeWorkspaceApi(workspaceRoot, files, { watcher }),
      {
        storageUri: { fsPath: storagePath },
        createIndexClient: () => client,
      },
    );

    await vi.waitFor(() => {
      expect(client.initialize).toHaveBeenCalledWith(
        join(storagePath, "index", "code-index.sqlite"),
        expect.any(String),
      );
    });

    watcher.fireChange({ fsPath: sourcePath });
    await vi.waitFor(() => expect(client.enqueueChanges).toHaveBeenCalled());
    await intelligence.dispose();
    await intelligence.dispose();

    expect(watcher.dispose).toHaveBeenCalledTimes(1);
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it("indexes VS Code workspace files and excludes sensitive files", async () => {
    const workspaceRoot = "E:\\work\\repo";
    const files = new Map([
      [
        `${workspaceRoot}\\src\\modelAccess.ts`,
        [
          "export function createDeepSeekProvider() {",
          '  return { provider: "deepseek" };',
          "}",
        ].join("\n"),
      ],
      [`${workspaceRoot}\\.env`, "DEEPSEEK_API_KEY=should-not-be-indexed"],
    ]);

    const intelligence = createVsCodeWorkspaceIntelligence(createFakeVsCodeWorkspaceApi(workspaceRoot, files), {
      maxWorkspaceFiles: 20,
      maxFileBytes: 100_000,
    });

    const prompt = await intelligence.buildCodeIntelligencePrompt("模型接入 deepseek provider");

    expect(prompt).toContain("代码语义索引上下文");
    expect(prompt).toContain("createDeepSeekProvider");
    expect(prompt).toContain("src/modelAccess.ts");
    expect(prompt).not.toContain("DEEPSEEK_API_KEY");
    expect(intelligence.getStatus()).toBe("ready");
  });

  it("reuses cached source until a watcher change marks the file dirty", async () => {
    const workspaceRoot = "E:\\work\\repo";
    const watcher = createFakeWatcher();
    const files = new Map([[`${workspaceRoot}\\src\\modelAccess.ts`, "export function createDeepSeekProvider() {}"]]);
    let readCount = 0;
    const intelligence = createVsCodeWorkspaceIntelligence(
      createFakeVsCodeWorkspaceApi(workspaceRoot, files, {
        watcher,
        onRead: () => {
          readCount += 1;
        },
      }),
    );

    await intelligence.buildCodeIntelligencePrompt("createDeepSeekProvider");
    await intelligence.buildCodeIntelligencePrompt("createDeepSeekProvider");
    expect(readCount).toBe(1);

    files.set(`${workspaceRoot}\\src\\modelAccess.ts`, "export function createModelRunner() {}");
    watcher.fireChange({ fsPath: `${workspaceRoot}\\src\\modelAccess.ts` });
    const prompt = await intelligence.buildCodeIntelligencePrompt("createModelRunner");

    expect(readCount).toBe(2);
    expect(prompt).toContain("createModelRunner");
  });

  it("removes deleted watcher paths from the source cache", async () => {
    const workspaceRoot = "E:\\work\\repo";
    const watcher = createFakeWatcher();
    const files = new Map([[`${workspaceRoot}\\src\\modelAccess.ts`, "export function createDeepSeekProvider() {}"]]);
    const intelligence = createVsCodeWorkspaceIntelligence(createFakeVsCodeWorkspaceApi(workspaceRoot, files, { watcher }));

    expect(await intelligence.buildCodeIntelligencePrompt("createDeepSeekProvider")).toContain("createDeepSeekProvider");

    files.delete(`${workspaceRoot}\\src\\modelAccess.ts`);
    watcher.fireDelete({ fsPath: `${workspaceRoot}\\src\\modelAccess.ts` });

    expect(await intelligence.buildCodeIntelligencePrompt("createDeepSeekProvider")).toBe("");
  });
});

function createFakeVsCodeWorkspaceApi(
  workspaceRoot: string,
  files: Map<string, string>,
  options: FakeVsCodeWorkspaceApiOptions = {},
): VsCodeWorkspaceApi {
  return {
    Uri: {
      parse: (value: string) => ({ fsPath: fromFileUri(value), toString: () => value }),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      findFiles: async (_include, _exclude, maxResults) =>
        [...files.keys()].slice(0, maxResults ?? files.size).map((fsPath) => ({
          fsPath,
          toString: () => toFileUri(fsPath),
        })),
      fs: {
        stat: async (uri) => {
          const text = files.get(uri.fsPath);
          if (text === undefined) throw Object.assign(new Error("FileNotFound"), { code: "FileNotFound" });
          return { mtime: 1_000, size: Buffer.byteLength(text, "utf8") };
        },
        readFile: async (uri) => {
          options.onRead?.();
          return new TextEncoder().encode(files.get(uri.fsPath) ?? "");
        },
      },
      createFileSystemWatcher: options.watcher
        ? () => ({
            onDidCreate: (listener) => createFakeDisposable(registerFakeWatcherHandler(options.watcher!, "create", listener)),
            onDidChange: (listener) => createFakeDisposable(registerFakeWatcherHandler(options.watcher!, "change", listener)),
            onDidDelete: (listener) => createFakeDisposable(registerFakeWatcherHandler(options.watcher!, "delete", listener)),
            dispose: options.watcher!.dispose,
          })
        : undefined,
      asRelativePath: (uriOrPath) => {
        const fsPath = typeof uriOrPath === "string" ? uriOrPath : uriOrPath.fsPath;
        return fsPath.replace(workspaceRoot, "").replace(/^\\/, "");
      },
    },
  };
}

function createFakeWatcher(): FakeWatcher {
  const handlers = {
    create: new Set<(uri: WorkspaceUri) => void>(),
    change: new Set<(uri: WorkspaceUri) => void>(),
    delete: new Set<(uri: WorkspaceUri) => void>(),
  };

  return {
    dispose: vi.fn(),
    fireCreate(uri) {
      for (const handler of handlers.create) {
        handler(uri);
      }
    },
    fireChange(uri) {
      for (const handler of handlers.change) {
        handler(uri);
      }
    },
    fireDelete(uri) {
      for (const handler of handlers.delete) {
        handler(uri);
      }
    },
    _handlers: handlers,
  } as FakeWatcher & { _handlers: typeof handlers };
}

function createFakeIndexClient() {
  const readyWriter = {
    state: "ready" as const,
    role: "writer" as const,
    schemaVersion: 1,
    capabilities: { sqlite: true, wal: true, foreignKeys: true, fts5: true },
  };
  return {
    initialize: vi.fn(async () => readyWriter),
    getStatus: vi.fn(async () => readyWriter),
    listIndexedFiles: vi.fn(async () => []),
    enqueueChanges: vi.fn(async () => undefined),
    claimNextJob: vi.fn(async () => undefined),
    applyFileSnapshot: vi.fn(async () => undefined),
    updateFileMetadata: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    completeJob: vi.fn(async () => undefined),
    failJob: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function toFileUri(fsPath: string): string {
  return `file:///${fsPath.replace(/\\/g, "/")}`;
}

function fromFileUri(uri: string): string {
  return uri.replace(/^file:\/\//, "").replace(/^\/(\w:)/, "$1").replace(/\//g, "\\");
}

function registerFakeWatcherHandler(
  watcher: FakeWatcher,
  kind: "create" | "change" | "delete",
  listener: (uri: WorkspaceUri) => void,
): () => void {
  const handlers = (watcher as FakeWatcher & {
    _handlers: Record<"create" | "change" | "delete", Set<(uri: WorkspaceUri) => void>>;
  })._handlers;
  handlers[kind].add(listener);
  return () => handlers[kind].delete(listener);
}

function createFakeDisposable(dispose: () => void) {
  return { dispose };
}
