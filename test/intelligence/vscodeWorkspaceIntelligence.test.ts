import { describe, expect, it } from "vitest";

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
  fireCreate(uri: WorkspaceUri): void;
  fireChange(uri: WorkspaceUri): void;
  fireDelete(uri: WorkspaceUri): void;
};

type FakeVsCodeWorkspaceApiOptions = {
  watcher?: FakeWatcher;
  onRead?: () => void;
};

describe("isIndexableWorkspacePath", () => {
  it("excludes generated, dependency, local debug, and sensitive paths", () => {
    expect(isIndexableWorkspacePath("src/extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules/react/index.js")).toBe(false);
    expect(isIndexableWorkspacePath("dist/extension.js")).toBe(false);
    expect(isIndexableWorkspacePath(".git/config")).toBe(false);
    expect(isIndexableWorkspacePath(".local-vscode-user-data/User/settings.json")).toBe(false);
    expect(isIndexableWorkspacePath(".env")).toBe(false);
    expect(isIndexableWorkspacePath(".env.local")).toBe(false);
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
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      findFiles: async (_include, _exclude, maxResults) =>
        [...files.keys()].slice(0, maxResults ?? files.size).map((fsPath) => ({ fsPath })),
      fs: {
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
            dispose: () => undefined,
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
