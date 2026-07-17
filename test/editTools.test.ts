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
    confirmation?: "Apply all" | "Cancel" | undefined;
    beforeConfirmation?: () => void;
    symbolicLinkPaths?: string[];
    dirtyPaths?: string[];
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
  const executeCommand = vi.fn(async () => undefined);
  let contentProvider: { provideTextDocumentContent(uri: FakeUri): string } | undefined;
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
        parse: (value: string) => createUri(value.split(":", 1)[0] ?? "untitled", value),
      },
      FileType: { Directory: 2, SymbolicLink: 64 },
      WorkspaceEdit: FakeWorkspaceEdit,
      Position: class {},
      Range: class {},
      commands: { executeCommand },
      window: {
        showInformationMessage: vi.fn(async () => {
          options.beforeConfirmation?.();
          return options.confirmation;
        }),
      },
      workspace: {
        workspaceFolders: [{ uri: root }],
        textDocuments: (options.dirtyPaths ?? []).map((path) => ({ uri: createUri("file", toFsPath(path)), isDirty: true })),
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
      { "src/example.ts": "safe", "src/link/child.ts": "external", "src/dirty.ts": "before", ".env": "SECRET=value" },
      { symbolicLinkPaths: ["src/link"], dirtyPaths: ["src/dirty.ts"] },
    );

    for (const path of ["../secret.ts", "C:\\secret.ts", ".env", "src", "src/link/child.ts"]) {
      await expect(readFile({ path }, fake.api)).rejects.toThrow("Invalid readFile path");
    }
    await expect(readFile({ path: "src/dirty.ts" }, fake.api)).rejects.toThrow("Workspace file has unsaved changes");
    expect(fake.readFile).not.toHaveBeenCalled();
  });

  it("opens one review document and does not write it when cancelled", async () => {
    const fake = createFakeVsCodeApi({ "src/first.ts": "before", "src/second.ts": "old" }, { confirmation: "Cancel" });
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
    expect(fake.executeCommand).toHaveBeenCalledTimes(1);
    expect(fake.executeCommand).toHaveBeenCalledWith("vscode.open", expect.anything());
    expect(fake.executeCommand).not.toHaveBeenCalledWith("vscode.diff", expect.anything(), expect.anything(), expect.any(String));
    const preview = fake.executeCommand.mock.calls[0]?.[1] as FakeUri;
    expect(fake.previewText(preview)).toContain("src/first.ts");
    expect(fake.previewText(preview)).toContain("-before");
    expect(fake.previewText(preview)).toContain("+after");
    expect(fake.previewText(preview)).toContain("src/second.ts");
    expect(fake.applyEdit).not.toHaveBeenCalled();
  });

  it("applies confirmed create, replace, rename and delete operations once", async () => {
    const fake = createFakeVsCodeApi(
      { "src/replace.ts": "before", "src/from.ts": "rename me", "src/delete.ts": "delete me" },
      { confirmation: "Apply all" },
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
    const invalid = createFakeVsCodeApi({ "src/example.ts": "duplicate duplicate" }, { confirmation: "Apply all" });
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
      dirtyService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], new AbortController().signal),
    ).rejects.toThrow("unsaved changes");
    await expect(
      dirtyService.apply([{ kind: "replace", path: "src/EXAMPLE.ts", oldText: "before", newText: "after" }], new AbortController().signal),
    ).rejects.toThrow("unsaved changes");
    expect(dirty.executeCommand).not.toHaveBeenCalled();

    const sourceSymlink = createFakeVsCodeApi(
      { "src/example.ts": "before" },
      { confirmation: "Apply all", beforeConfirmation: () => sourceSymlink.symbolicLinks.add("E:\\work\\repo\\src\\example.ts") },
    );
    const sourceSymlinkService = createEditPreviewService(sourceSymlink.api);
    await expect(
      sourceSymlinkService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(sourceSymlink.applyEdit).not.toHaveBeenCalled();

    const conflict = createFakeVsCodeApi(
      { "src/example.ts": "before" },
      { confirmation: "Apply all", beforeConfirmation: () => conflict.files.set("E:\\work\\repo\\src\\example.ts", "changed") },
    );
    const conflictService = createEditPreviewService(conflict.api);
    await expect(
      conflictService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(conflict.applyEdit).not.toHaveBeenCalled();

    const createConflict = createFakeVsCodeApi(
      { "src/placeholder.ts": "placeholder" },
      { confirmation: "Apply all", beforeConfirmation: () => createConflict.files.set("E:\\work\\repo\\src\\new.ts", "other") },
    );
    const createConflictService = createEditPreviewService(createConflict.api);
    await expect(
      createConflictService.apply([{ kind: "create", path: "src/new.ts", content: "new" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(createConflict.applyEdit).not.toHaveBeenCalled();

    const renameTargetSymlink = createFakeVsCodeApi(
      { "src/from.ts": "before" },
      { confirmation: "Apply all", beforeConfirmation: () => renameTargetSymlink.symbolicLinks.add("E:\\work\\repo\\src\\to.ts") },
    );
    const renameTargetSymlinkService = createEditPreviewService(renameTargetSymlink.api);
    await expect(
      renameTargetSymlinkService.apply([{ kind: "rename", from: "src/from.ts", to: "src/to.ts" }], new AbortController().signal),
    ).resolves.toContain("changed since the preview");
    expect(renameTargetSymlink.applyEdit).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = createFakeVsCodeApi({ "src/example.ts": "before" }, {
      confirmation: "Apply all",
      beforeConfirmation: () => controller.abort(),
    });
    const cancelledService = createEditPreviewService(cancelled.api);
    await expect(
      cancelledService.apply([{ kind: "replace", path: "src/example.ts", oldText: "before", newText: "after" }], controller.signal),
    ).resolves.toContain("cancelled");
    expect(cancelled.applyEdit).not.toHaveBeenCalled();
  });
});
