import { describe, expect, it, vi } from "vitest";
import { createApplyEditTool } from "../src/extension/agent/applyEditTool";
import { createEditPreviewService, type VsCodeEditApi } from "../src/extension/agent/editPreviewService";
import { createReadFileTool } from "../src/extension/agent/readFileTool";

type FakeUri = {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
};

type FakeCodeLens = {
  command?: { title: string; command: string; arguments?: unknown[] };
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
    reviewChoice?: "accept" | "discard";
    beforeReviewChoice?: () => void;
    symbolicLinkPaths?: string[];
    dirtyPaths?: string[];
    dirtyContents?: Record<string, string>;
    renderSideBySide?: boolean;
  } = {},
): {
  api: VsCodeEditApi;
  files: Map<string, string>;
  symbolicLinks: Set<string>;
  readFile: ReturnType<typeof vi.fn>;
  applyEdit: ReturnType<typeof vi.fn>;
  executeCommand: ReturnType<typeof vi.fn>;
  showInformationMessage: ReturnType<typeof vi.fn>;
  reviewActions: string[];
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
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const reviewActions: string[] = [];
  const showInformationMessage = vi.fn(async () => undefined);
  let contentProvider: { provideTextDocumentContent(uri: FakeUri): string } | undefined;
  let codeLensProvider: { provideCodeLenses(document: { uri: FakeUri }): FakeCodeLens[] | Promise<FakeCodeLens[]> } | undefined;
  let activeEditorUri: FakeUri | undefined;
  let reviewTriggered = false;
  const executeCommand = vi.fn(async (command: string, ...args: unknown[]) => {
    if (command === "vscode.diff") activeEditorUri = args[1] as FakeUri;
    if (command !== "vscode.diff" || reviewTriggered || !options.reviewChoice || !codeLensProvider) return;
    reviewTriggered = true;
    const lenses = await codeLensProvider.provideCodeLenses({ uri: args[1] as FakeUri });
    reviewActions.push(...lenses.map((lens) => lens.command?.title ?? ""));
    const title = options.reviewChoice === "accept" ? "接受全部" : "放弃";
    const action = lenses.find((lens) => lens.command?.title === title)?.command;
    options.beforeReviewChoice?.();
    if (action) await registeredCommands.get(action.command)?.();
  });
  const stat = vi.fn(async (uri: FakeUri) => {
    if (symbolicLinks.has(uri.fsPath)) return { type: 1 | 64 };
    if (files.has(uri.fsPath)) return { type: 1 };
    if ([...files.keys(), ...symbolicLinks].some((path) => path.startsWith(`${uri.fsPath}\\`))) return { type: 2 };
    throw new Error("FileNotFound");
  });

  return {
    api: {
      Uri: {
        joinPath: (base: FakeUri, ...parts: string[]) => createUri("file", `${base.fsPath}\\${parts.join("\\")}`),
        parse: (value: string) => {
          const separator = value.indexOf(":");
          return createUri(value.slice(0, separator), value.slice(separator + 1));
        },
      },
      CodeLens: class {
        constructor(readonly range: unknown, readonly command?: FakeCodeLens["command"]) {}
      },
      EventEmitter: class {
        readonly event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      FileType: { Directory: 2, SymbolicLink: 64 },
      WorkspaceEdit: FakeWorkspaceEdit,
      Position: class {},
      Range: class {},
      commands: {
        executeCommand,
        registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
          registeredCommands.set(command, callback);
          return { dispose: () => registeredCommands.delete(command) };
        },
      },
      languages: {
        registerCodeLensProvider: (_selector: unknown, provider: typeof codeLensProvider) => {
          codeLensProvider = provider;
          return { dispose: () => { codeLensProvider = undefined; } };
        },
      },
      window: {
        get activeTextEditor() {
          return activeEditorUri ? { document: { uri: activeEditorUri } } : undefined;
        },
        showInformationMessage,
      },
      workspace: {
        workspaceFolders: [{ uri: root }],
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
    showInformationMessage,
    reviewActions,
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
        reviewChoice: "discard",
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
    ).resolves.toContain("cancelled");

    expect(fake.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "LoopAgent: src/example.ts",
    );
    const original = fake.executeCommand.mock.calls[0]?.[1] as FakeUri;
    const target = fake.executeCommand.mock.calls[0]?.[2] as FakeUri;
    expect(fake.previewText(original)).toBe("before");
    expect(fake.previewText(target)).toBe("after");
    expect(fake.executeCommand).toHaveBeenNthCalledWith(2, "toggle.diff.renderSideBySide", target);
    expect(fake.reviewActions).toEqual(["接受全部", "放弃"]);
    expect(fake.showInformationMessage).not.toHaveBeenCalled();
  });

  it("opens code diff previews and does not write them when cancelled", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before", "src/second.ts": "old" }, { reviewChoice: "discard" });
    const service = createEditPreviewService(fake.api);

    await expect(
      service.apply(
        [
          { kind: "replace", path: "src/first.ts", oldText: "before", newText: "after" },
          { kind: "replace", path: "src/second.ts", oldText: "old", newText: "new" },
        ],
        new AbortController().signal,
      ),
    ).resolves.toContain("cancelled");
    expect(fake.executeCommand).toHaveBeenCalledTimes(4);
    expect(fake.executeCommand).toHaveBeenNthCalledWith(
      1,
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "LoopAgent: src/first.ts",
    );
    expect(fake.executeCommand).toHaveBeenNthCalledWith(
      3,
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "LoopAgent: src/second.ts",
    );
    expect(fake.executeCommand).toHaveBeenNthCalledWith(2, "toggle.diff.renderSideBySide", expect.anything());
    expect(fake.executeCommand).toHaveBeenNthCalledWith(4, "toggle.diff.renderSideBySide", expect.anything());
    expect(fake.applyEdit).not.toHaveBeenCalled();
  });

  it("applies confirmed create, replace, rename and delete operations once", async () => {
    const fake = createFakeVsCodeApi(
      { "src/replace.ts": "before", "src/from.ts": "rename me", "src/delete.ts": "delete me" },
      { reviewChoice: "accept" },
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

  it("rejects invalid replacements, snapshot conflicts, and cancellation without writing", async () => {
    const invalid = createFakeVsCodeApi({ "src/example.ts": "duplicate duplicate" }, { reviewChoice: "accept" });
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

    const sourceSymlink = createFakeVsCodeApi(
      { "src/example.ts": "before" },
      { reviewChoice: "accept", beforeReviewChoice: () => sourceSymlink.symbolicLinks.add("E:\\work\\repo\\src\\example.ts") },
    );
    const sourceSymlinkService = createEditPreviewService(sourceSymlink.api);
    await expect(
      sourceSymlinkService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(sourceSymlink.applyEdit).not.toHaveBeenCalled();

    const conflict = createFakeVsCodeApi(
      { "src/example.ts": "before" },
      { reviewChoice: "accept", beforeReviewChoice: () => conflict.files.set("E:\\work\\repo\\src\\example.ts", "changed") },
    );
    const conflictService = createEditPreviewService(conflict.api);
    await expect(
      conflictService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(conflict.applyEdit).not.toHaveBeenCalled();

    const createConflict = createFakeVsCodeApi(
      { "src/placeholder.ts": "placeholder" },
      { reviewChoice: "accept", beforeReviewChoice: () => createConflict.files.set("E:\\work\\repo\\src\\new.ts", "other") },
    );
    const createConflictService = createEditPreviewService(createConflict.api);
    await expect(
      createConflictService.apply([{ kind: "create", path: "src/new.ts", content: "new" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(createConflict.applyEdit).not.toHaveBeenCalled();

    const renameTargetSymlink = createFakeVsCodeApi(
      { "src/from.ts": "before" },
      { reviewChoice: "accept", beforeReviewChoice: () => renameTargetSymlink.symbolicLinks.add("E:\\work\\repo\\src\\to.ts") },
    );
    const renameTargetSymlinkService = createEditPreviewService(renameTargetSymlink.api);
    await expect(
      renameTargetSymlinkService.apply([{ kind: "rename", from: "src/from.ts", to: "src/to.ts" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(renameTargetSymlink.applyEdit).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = createFakeVsCodeApi({ "src/example.ts": "before" }, {
      reviewChoice: "accept",
      beforeReviewChoice: () => controller.abort(),
    });
    const cancelledService = createEditPreviewService(cancelled.api);
    await expect(
      cancelledService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], controller.signal),
    ).resolves.toContain("cancelled");
    expect(cancelled.applyEdit).not.toHaveBeenCalled();
  });

  it("handles line ending differences between model output and file content", async () => {
    const crlfFile = "line1\r\nline2\r\nline3";
    const fake = createFakeVsCodeApi({ "src/crlf.ts": crlfFile }, { reviewChoice: "accept" });
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
    const fake1 = createFakeVsCodeApi({ "src/example.ts": "content here" }, { reviewChoice: "accept" });
    const service1 = createEditPreviewService(fake1.api);
    await expect(
      service1.apply([{ kind: "replace", path: "src/example.ts", oldText: "missing", newText: "new" }], new AbortController().signal),
    ).rejects.toThrow("oldText not found in file");

    const fake2 = createFakeVsCodeApi({ "src/dup.ts": "dup dup dup" }, { reviewChoice: "accept" });
    const service2 = createEditPreviewService(fake2.api);
    await expect(
      service2.apply([{ kind: "replace", path: "src/dup.ts", oldText: "dup", newText: "changed" }], new AbortController().signal),
    ).rejects.toThrow("matches 3 times");
  });
});
