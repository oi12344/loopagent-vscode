import { describe, expect, it, vi } from "vitest";
import { createApplyEditTool } from "../src/extension/agent/applyEditTool";
import { computeLineStats, createEditPreviewService, type VsCodeEditApi } from "../src/extension/agent/editPreviewService";
import { createReadFileTool } from "../src/extension/agent/readFileTool";

type FakeUri = {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
};

type FakeWorkspaceEditEntry =
  | { kind: "replace"; path: string; text: string }
  | { kind: "create"; path: string }
  | { kind: "insert"; path: string; text: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string };

class FakeWorkspaceEdit {
  readonly entries: FakeWorkspaceEditEntry[] = [];

  replace(uri: FakeUri, _range: unknown, text: string): void {
    this.entries.push({ kind: "replace", path: uri.fsPath, text });
  }

  createFile(uri: FakeUri): void {
    this.entries.push({ kind: "create", path: uri.fsPath });
  }

  insert(uri: FakeUri, _position: unknown, text: string): void {
    this.entries.push({ kind: "insert", path: uri.fsPath, text });
  }

  renameFile(from: FakeUri, to: FakeUri): void {
    this.entries.push({ kind: "rename", from: from.fsPath, to: to.fsPath });
  }

  deleteFile(uri: FakeUri): void {
    this.entries.push({ kind: "delete", path: uri.fsPath });
  }
}

function createFakeVsCodeApi(
  initialFiles: Record<string, string>,
  options: {
    symbolicLinkPaths?: string[];
    dirtyPaths?: string[];
    dirtyContents?: Record<string, string>;
    renderSideBySide?: boolean;
    extraRoots?: string[];
  } = {},
): {
  api: VsCodeEditApi;
  files: Map<string, string>;
  symbolicLinks: Set<string>;
  readFile: ReturnType<typeof vi.fn>;
  applyEdit: ReturnType<typeof vi.fn>;
  executeCommand: ReturnType<typeof vi.fn>;
  previewText(uri: FakeUri): string | undefined;
} {
  const root = createUri("file", "E:\\work\\repo");
  const toFsPath = (path: string) => `${root.fsPath}\\${path.replace(/\//g, "\\")}`;
  const files = new Map(
    Object.entries(initialFiles).map(([path, content]) => [toFsPath(path), content]),
  );
  const symbolicLinks = new Set((options.symbolicLinkPaths ?? []).map(toFsPath));
  const readFile = vi.fn(async (uri: FakeUri) => {
    const content = files.get(uri.fsPath);
    if (content === undefined) {
      throw new Error("FileNotFound");
    }
    return new TextEncoder().encode(content);
  });
  const applyEdit = vi.fn(async () => true);
  let contentProvider: { provideTextDocumentContent(uri: FakeUri): string } | undefined;
  type FakeTab = { input: { original?: FakeUri; modified?: FakeUri } };
  const openTabs: FakeTab[] = [];
  const executeCommand = vi.fn(async (command: string, original?: FakeUri, modified?: FakeUri) => {
    if (command !== "vscode.diff") return;
    openTabs.push({ input: { original, modified } });
  });
  const stat = vi.fn(async (uri: FakeUri) => {
    if (symbolicLinks.has(uri.fsPath)) return { type: 1 | 64 };
    if (files.has(uri.fsPath)) return { type: 1 };
    if ([...files.keys(), ...symbolicLinks].some((path) => path.startsWith(`${uri.fsPath}\\`))) return { type: 2 };
    throw new Error("FileNotFound");
  });
  const extraRoots = (options.extraRoots ?? []).map((path) => ({ uri: createUri("file", path) }));

  return {
    api: {
      Uri: {
        joinPath: (base: FakeUri, ...parts: string[]) => createUri("file", `${base.fsPath}\\${parts.join("\\")}`),
        parse: (value: string) => {
          const separator = value.indexOf(":");
          return createUri(value.slice(0, separator), value.slice(separator + 1));
        },
      },
      FileType: { Directory: 2, SymbolicLink: 64 },
      WorkspaceEdit: FakeWorkspaceEdit,
      Position: class {},
      Range: class {},
      commands: {
        executeCommand,
      },
      window: {
        tabGroups: {
          get all() {
            return [{ tabs: openTabs }];
          },
          close: vi.fn(async () => true),
        },
      },
      workspace: {
        workspaceFolders: [{ uri: root }, ...extraRoots],
        getConfiguration: () => ({
          get: (_section: string, defaultValue: boolean) => options.renderSideBySide ?? defaultValue,
        }),
        textDocuments: (options.dirtyPaths ?? []).map((path) => ({
          uri: createUri("file", toFsPath(path)),
          isDirty: true,
          getText: () => options.dirtyContents?.[path] ?? initialFiles[path] ?? "",
        })),
        fs: { readFile, stat },
        applyEdit,
        registerTextDocumentContentProvider: vi.fn((_scheme, provider) => {
          contentProvider = provider as { provideTextDocumentContent(uri: FakeUri): string };
          return { dispose: vi.fn() };
        }),
      },
    } as unknown as VsCodeEditApi,
    files,
    symbolicLinks,
    readFile,
    applyEdit,
    executeCommand,
    previewText: (uri) => contentProvider?.provideTextDocumentContent(uri),
  };
}

function createUri(scheme: string, fsPath: string): FakeUri {
  return {
    scheme,
    path: fsPath,
    fsPath,
    toString: () => `${scheme}:${fsPath}`,
  };
}

async function readFile(input: unknown, api: VsCodeEditApi): Promise<string> {
  return createReadFileTool(api).invoke({
    request: { id: "read-1", name: "readFile", rawArguments: "{}", input },
    input,
    signal: new AbortController().signal,
  });
}

describe("code generation edit tools", () => {
  it("advertises each structured applyEdit operation to the model", () => {
    const tool = createApplyEditTool({ apply: vi.fn(), dispose: vi.fn() });
    const changes = (tool.inputSchema.properties as Record<string, { items?: { oneOf?: unknown[] } }>).changes;

    for (const kind of ["replace", "create", "rename", "delete"]) {
      expect(changes.items?.oneOf).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ kind: expect.objectContaining({ enum: [kind] }) }),
        }),
      );
    }
  });

  it("reads a requested line range and reports truncation", async () => {
    const fake = createFakeVsCodeApi({ "src/example.ts": "one\ntwo\nthree\nfour", "src/large.ts": "x".repeat(20_001) });

    await expect(readFile({ path: "src/example.ts", startLine: 2, endLine: 3 }, fake.api)).resolves.toBe("two\nthree");
    await expect(readFile({ path: "src/large.ts" }, fake.api)).resolves.toContain(
      "Read file was truncated at 20000 characters; request a line range.",
    );
  });

  it("rejects outside and sensitive paths before reading", async () => {
    const fake = createFakeVsCodeApi(
      { "src/example.ts": "safe", "src/link/child.ts": "external", ".env": "SECRET=value" },
      { symbolicLinkPaths: ["src/link"] },
    );

    for (const path of ["../secret.ts", "C:\\secret.ts", ".env", "src", "src/link/child.ts"]) {
      await expect(readFile({ path }, fake.api)).rejects.toThrow("Invalid readFile path");
    }
    expect(fake.readFile).not.toHaveBeenCalled();
  });

  it("reads and previews replacements from an unsaved editor buffer", async () => {
    const fake = createFakeVsCodeApi(
      { "src/example.ts": "saved content" },
      {
        dirtyPaths: ["src/example.ts"],
        dirtyContents: { "src/example.ts": "before" },
      },
    );

    await expect(readFile({ path: "src/example.ts" }, fake.api)).resolves.toBe("before");

    const service = createEditPreviewService(fake.api);
    await expect(
      service.apply(
        [{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");

    expect(fake.applyEdit).toHaveBeenCalledOnce();
    expect(fake.executeCommand).not.toHaveBeenCalled();
  });

  it("applies multiple changes without opening any diff preview upfront", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before", "src/second.ts": "old" });
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply(
        [
          { kind: "replace", path: "src/first.ts", oldText: "before", newText: "after" },
          { kind: "replace", path: "src/second.ts", oldText: "old", newText: "new" },
        ],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");
    expect(fake.executeCommand).not.toHaveBeenCalled();
    expect(fake.applyEdit).toHaveBeenCalledTimes(1);
  });

  it("opens a diff preview on demand for a file from a past applied edit", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before" });
    let captured: { notificationId: string } | undefined;
    const notify = vi.fn((notice: { notificationId: string }) => {
      captured = notice;
    });
    const service = createEditPreviewService(fake.api, { notify });

    await service.apply(
      [{ kind: "replace", path: "src/first.ts", oldText: "before", newText: "after" }],
      new AbortController().signal,
    );

    await service.openFilePreview(captured!.notificationId, "src/first.ts");

    expect(fake.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "LoopAgent: src/first.ts",
    );
    const original = fake.executeCommand.mock.calls[0]?.[1] as FakeUri;
    const target = fake.executeCommand.mock.calls[0]?.[2] as FakeUri;
    expect(fake.previewText(original)).toBe("before");
    expect(fake.previewText(target)).toBe("after");
  });

  it("applies confirmed create, replace, rename and delete operations once", async () => {
    const fake = createFakeVsCodeApi(
      { "src/replace.ts": "before", "src/from.ts": "rename me", "src/delete.ts": "delete me" },
    );
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply(
        [
          { kind: "replace", path: "src/replace.ts", oldText: "before", newText: "after" },
          { kind: "create", path: "src/new.ts", content: "new file" },
          { kind: "rename", from: "src/from.ts", to: "src/to.ts" },
          { kind: "delete", path: "src/delete.ts" },
        ],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");

    expect(fake.applyEdit).toHaveBeenCalledTimes(1);
    expect((fake.applyEdit.mock.calls[0]?.[0] as FakeWorkspaceEdit).entries).toEqual([
      { kind: "replace", path: "E:\\work\\repo\\src\\replace.ts", text: "after" },
      { kind: "create", path: "E:\\work\\repo\\src\\new.ts" },
      { kind: "insert", path: "E:\\work\\repo\\src\\new.ts", text: "new file" },
      { kind: "rename", from: "E:\\work\\repo\\src\\from.ts", to: "E:\\work\\repo\\src\\to.ts" },
      { kind: "delete", path: "E:\\work\\repo\\src\\delete.ts" },
    ]);
  });

  it("rejects invalid replacements and unsaved-document conflicts without writing", async () => {
    const invalid = createFakeVsCodeApi({ "src/example.ts": "duplicate duplicate" });
    const invalidService = createEditPreviewService(invalid.api);
    for (const oldText of ["", "missing", "duplicate"]) {
      await expect(
        invalidService.apply([{ kind: "replace", path: "src/example.ts", oldText, newText: "new" }], new AbortController().signal),
      ).rejects.toThrow("Invalid replace operation");
    }
    expect(invalid.executeCommand).not.toHaveBeenCalled();
    expect(invalid.applyEdit).not.toHaveBeenCalled();

    const dirty = createFakeVsCodeApi({ "src/example.ts": "before" }, { dirtyPaths: ["src/example.ts"] });
    const dirtyService = createEditPreviewService(dirty.api);
    await expect(
      dirtyService.apply([{ kind: "delete", path: "src/example.ts" }], new AbortController().signal),
    ).rejects.toThrow("unsaved changes");
    await expect(
      dirtyService.apply([{ kind: "rename", from: "src/EXAMPLE.ts", to: "src/other.ts" }], new AbortController().signal),
    ).rejects.toThrow("unsaved changes");
    expect(dirty.executeCommand).not.toHaveBeenCalled();
  });

  it("does not write when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = createFakeVsCodeApi({ "src/example.ts": "before" });
    const cancelledService = createEditPreviewService(cancelled.api);
    await expect(
      cancelledService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], controller.signal),
    ).resolves.toContain("cancelled");
    expect(cancelled.applyEdit).not.toHaveBeenCalled();
  });

  it("handles line ending differences between model output and file content", async () => {
    const crlfFile = "line1\r\nline2\r\nline3";
    const fake = createFakeVsCodeApi({ "src/crlf.ts": crlfFile });
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply(
        [{ kind: "replace", path: "src/crlf.ts", oldText: "line1\nline2", newText: "changed\nline2" }],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");

    expect(fake.applyEdit).toHaveBeenCalledOnce();
    const edit = fake.applyEdit.mock.calls[0]?.[0] as FakeWorkspaceEdit;
    const replaceEntry = edit.entries.find((e) => e.kind === "replace");
    expect(replaceEntry).toBeDefined();
    expect((replaceEntry as { kind: "replace"; text: string }).text).toBe("changed\r\nline2\r\nline3");
  });

  it("reports distinct error messages for missing vs duplicate oldText", async () => {
    const fake1 = createFakeVsCodeApi({ "src/example.ts": "content here" });
    const service1 = createEditPreviewService(fake1.api);
    await expect(
      service1.apply([{ kind: "replace", path: "src/example.ts", oldText: "missing", newText: "new" }], new AbortController().signal),
    ).rejects.toThrow("oldText not found in file");

    const fake2 = createFakeVsCodeApi({ "src/dup.ts": "dup dup dup" });
    const service2 = createEditPreviewService(fake2.api);
    await expect(
      service2.apply([{ kind: "replace", path: "src/dup.ts", oldText: "dup", newText: "changed" }], new AbortController().signal),
    ).rejects.toThrow("matches 3 times");
  });

  it("writes the change to disk and notifies with every changed file's path", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before", "src/second.ts": "old" });
    const notify = vi.fn();
    const service = createEditPreviewService(fake.api, { notify });

    await expect(
      service.apply(
        [
          { kind: "replace", path: "src/first.ts", oldText: "before", newText: "after" },
          { kind: "replace", path: "src/second.ts", oldText: "old", newText: "new" },
        ],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");

    expect(fake.applyEdit).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["src/first.ts", "src/second.ts"], notificationId: expect.any(String) }),
    );
  });

  it("opens a diff preview for a specific file from a past applied edit on demand", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before", "src/second.ts": "old" });
    let captured: { notificationId: string } | undefined;
    const notify = vi.fn((notice: { notificationId: string }) => {
      captured = notice;
    });
    const service = createEditPreviewService(fake.api, { notify });

    await service.apply(
      [
        { kind: "replace", path: "src/first.ts", oldText: "before", newText: "after" },
        { kind: "replace", path: "src/second.ts", oldText: "old", newText: "new" },
      ],
      new AbortController().signal,
    );

    await service.openFilePreview(captured!.notificationId, "src/second.ts");

    expect(fake.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "LoopAgent: src/second.ts",
    );
  });

  it("silently ignores openFilePreview for an unknown notification or file", async () => {
    const fake = createFakeVsCodeApi({ "src/example.ts": "before" });
    const service = createEditPreviewService(fake.api);

    await expect(service.openFilePreview("missing-notification", "src/example.ts")).resolves.toBeUndefined();
    expect(fake.executeCommand).not.toHaveBeenCalled();
  });

  it("computes added/removed line stats and passes them to the notifier", async () => {
    const fake = createFakeVsCodeApi({ "src/example.ts": "one\ntwo\nthree" });
    const notify = vi.fn();
    const service = createEditPreviewService(fake.api, { notify });

    await service.apply(
      [{ kind: "replace", path: "src/example.ts", oldText: "two", newText: "TWO\nBONUS" }],
      new AbortController().signal,
    );

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        fileStats: [{ path: "src/example.ts", added: 2, removed: 1 }],
      }),
    );
  });

  it("reverts only the requested file, leaving the other applied file intact", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before", "src/second.ts": "old" });
    let captured: { notificationId: string } | undefined;
    const notify = vi.fn((notice: { notificationId: string }) => {
      captured = notice;
    });
    const service = createEditPreviewService(fake.api, { notify });

    await service.apply(
      [
        { kind: "replace", path: "src/first.ts", oldText: "before", newText: "after" },
        { kind: "replace", path: "src/second.ts", oldText: "old", newText: "new" },
      ],
      new AbortController().signal,
    );
    fake.applyEdit.mockClear();

    await expect(service.revertFiles(captured!.notificationId, ["src/first.ts"])).resolves.toContain("undone");

    expect(fake.applyEdit).toHaveBeenCalledOnce();
    const edit = fake.applyEdit.mock.calls[0]?.[0] as FakeWorkspaceEdit;
    expect(edit.entries).toEqual([{ kind: "replace", path: "E:\\work\\repo\\src\\first.ts", text: "before" }]);

    await expect(service.revertFiles(captured!.notificationId, ["src/second.ts"])).resolves.toContain("undone");
  });

  it("reports nothing to undo for an unknown notification id", async () => {
    const fake = createFakeVsCodeApi({ "src/example.ts": "before" });
    const service = createEditPreviewService(fake.api);

    await expect(service.revertFiles("missing-notification", [])).resolves.toContain("Nothing to undo");
    expect(fake.applyEdit).not.toHaveBeenCalled();
  });

  it("undoes the last applied edit by restoring original content", async () => {
    const fake = createFakeVsCodeApi({ "src/example.ts": "before" });
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply(
        [{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");

    await expect(service.undoLast()).resolves.toContain("undone");
    const undoEdit = fake.applyEdit.mock.calls[1]?.[0] as FakeWorkspaceEdit;
    expect(undoEdit.entries).toEqual([{ kind: "replace", path: "E:\\work\\repo\\src\\example.ts", text: "before" }]);
  });

  it("reports nothing to undo when no edit has been applied yet", async () => {
    const fake = createFakeVsCodeApi({ "src/example.ts": "before" });
    const service = createEditPreviewService(fake.api);

    await expect(service.undoLast()).resolves.toContain("Nothing to undo");
    expect(fake.applyEdit).not.toHaveBeenCalled();
  });

  it("resolves a replace path against whichever workspace folder actually has the file", async () => {
    const fake = createFakeVsCodeApi(
      { "src/example.ts": "before" },
      { extraRoots: ["E:\\work\\other-repo"] },
    );
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply(
        [{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }],
        new AbortController().signal,
      ),
    ).resolves.toContain("applied");
    expect(fake.applyEdit).toHaveBeenCalledOnce();
  });

  it("creates a new file under the first workspace folder when multiple roots are open", async () => {
    const fake = createFakeVsCodeApi(
      { "src/placeholder.ts": "placeholder" },
      { extraRoots: ["E:\\work\\other-repo"] },
    );
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply([{ kind: "create", path: "src/new.ts", content: "new file" }], new AbortController().signal),
    ).resolves.toContain("applied");

    const edit = fake.applyEdit.mock.calls[0]?.[0] as FakeWorkspaceEdit;
    expect(edit.entries[0]).toEqual({ kind: "create", path: "E:\\work\\repo\\src\\new.ts" });
  });
});

describe("computeLineStats", () => {
  it("counts pure additions, pure removals, and mixed edits", () => {
    expect(computeLineStats("", "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(computeLineStats("a\nb", "")).toEqual({ added: 0, removed: 2 });
    expect(computeLineStats("a\nb\nc", "a\nX\nc")).toEqual({ added: 1, removed: 1 });
    expect(computeLineStats("same", "same")).toEqual({ added: 0, removed: 0 });
  });
});
