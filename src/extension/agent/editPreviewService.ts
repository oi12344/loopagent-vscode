import type * as vscode from "vscode";
import { isIndexableWorkspacePath, normalizePathSeparators } from "../intelligence/indexing/workspaceFilePolicy";

export type EditOperation =
  | { kind: "replace"; path: string; oldText: string; newText: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string };

export type EditPreviewService = {
  apply(changes: readonly EditOperation[], signal: AbortSignal): Promise<string>;
  dispose(): void;
};

export type VsCodeEditApi = {
  Uri: Pick<typeof vscode.Uri, "joinPath" | "parse">;
  CodeLens: typeof vscode.CodeLens;
  EventEmitter: typeof vscode.EventEmitter;
  FileType: Pick<typeof vscode.FileType, "Directory" | "SymbolicLink">;
  WorkspaceEdit: typeof vscode.WorkspaceEdit;
  Position: typeof vscode.Position;
  Range: typeof vscode.Range;
  commands: Pick<typeof vscode.commands, "executeCommand" | "registerCommand">;
  languages: Pick<typeof vscode.languages, "registerCodeLensProvider">;
  window: Pick<typeof vscode.window, "activeTextEditor">;
  workspace: Pick<
    typeof vscode.workspace,
    "workspaceFolders" | "textDocuments" | "fs" | "applyEdit" | "getConfiguration" | "registerTextDocumentContentProvider"
  >;
};

type Snapshot = {
  path: string;
  uri: vscode.Uri;
  content: string;
};

type PlannedChange =
  | { kind: "replace"; path: string; source: Snapshot; target: string }
  | { kind: "create"; path: string; content: string; uri: vscode.Uri }
  | { kind: "rename"; from: string; to: string; source: Snapshot; target: vscode.Uri }
  | { kind: "delete"; source: Snapshot };

const PREVIEW_SCHEME = "loopagent-edit-preview";
const ACCEPT_REVIEW_COMMAND = "loopagent.acceptEditReview";
const DISCARD_REVIEW_COMMAND = "loopagent.discardEditReview";

type ReviewChoice = "accept" | "discard";

export function createEditPreviewService(vscodeApi: VsCodeEditApi): EditPreviewService {
  const previewContents = new Map<string, string>();
  const pendingChoices = new Map<string, (choice: ReviewChoice) => void>();
  const codeLensChangeEmitter = new vscodeApi.EventEmitter<void>();
  const reviewRange = new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0));
  const registrations = [
    vscodeApi.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent(uri) {
        return previewContents.get(uri.toString()) ?? "";
      },
    }),
    vscodeApi.languages.registerCodeLensProvider({ scheme: PREVIEW_SCHEME }, {
      onDidChangeCodeLenses: codeLensChangeEmitter.event,
      provideCodeLenses(document) {
        const proposalId = getTargetProposalId(document.uri);
        if (!proposalId || !pendingChoices.has(proposalId)) return [];
        return [
          new vscodeApi.CodeLens(reviewRange, { title: "接受全部", command: ACCEPT_REVIEW_COMMAND, arguments: [proposalId] }),
          new vscodeApi.CodeLens(reviewRange, { title: "放弃", command: DISCARD_REVIEW_COMMAND, arguments: [proposalId] }),
        ];
      },
    }),
    vscodeApi.commands.registerCommand(ACCEPT_REVIEW_COMMAND, (proposalId: unknown) => {
      const id = typeof proposalId === "string" ? proposalId : getTargetProposalId(vscodeApi.window.activeTextEditor?.document.uri);
      if (id) pendingChoices.get(id)?.("accept");
    }),
    vscodeApi.commands.registerCommand(DISCARD_REVIEW_COMMAND, (proposalId: unknown) => {
      const id = typeof proposalId === "string" ? proposalId : getTargetProposalId(vscodeApi.window.activeTextEditor?.document.uri);
      if (id) pendingChoices.get(id)?.("discard");
    }),
  ];
  let proposalNumber = 0;

  return {
    async apply(changes, signal) {
      if (changes.length === 0) {
        throw new Error("Invalid applyEdit input: changes must not be empty");
      }
      if (signal.aborted) {
        return "Changes were cancelled.";
      }

      const proposal = await stageProposal(vscodeApi, changes);
      if (signal.aborted) {
        return "Changes were cancelled.";
      }

      const proposalId = `${++proposalNumber}`;
      const choicePromise = waitForReviewChoice(pendingChoices, codeLensChangeEmitter, proposalId, signal);
      try {
        await openPreviews(vscodeApi, previewContents, proposalId, proposal);
      } catch (error) {
        pendingChoices.get(proposalId)?.("discard");
        throw error;
      }
      const choice = await choicePromise;
      if (choice !== "accept" || signal.aborted) {
        return "Changes were cancelled.";
      }

      if (!(await snapshotsStillMatch(vscodeApi, proposal))) {
        return "Changes were not applied because a source file changed since the preview.";
      }

      const edit = createWorkspaceEdit(vscodeApi, proposal);
      return (await vscodeApi.workspace.applyEdit(edit)) ? "Changes were applied." : "Changes could not be applied.";
    },
    dispose() {
      for (const resolve of [...pendingChoices.values()]) resolve("discard");
      previewContents.clear();
      for (const registration of registrations) registration.dispose();
      codeLensChangeEmitter.dispose();
    },
  };
}

function waitForReviewChoice(
  pendingChoices: Map<string, (choice: ReviewChoice) => void>,
  codeLensChangeEmitter: vscode.EventEmitter<void>,
  proposalId: string,
  signal: AbortSignal,
): Promise<ReviewChoice> {
  return new Promise((resolve) => {
    function finish(choice: ReviewChoice) {
      if (!pendingChoices.delete(proposalId)) return;
      signal.removeEventListener("abort", abort);
      codeLensChangeEmitter.fire();
      resolve(choice);
    }
    function abort() {
      finish("discard");
    }

    pendingChoices.set(proposalId, finish);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function getTargetProposalId(uri: vscode.Uri | undefined): string | undefined {
  return uri ? /^\/([^/]+)\/target(?:\/|$)/.exec(uri.path)?.[1] : undefined;
}

export async function resolveWorkspaceFileUri(vscodeApi: VsCodeEditApi, rawPath: unknown): Promise<vscode.Uri> {
  if (typeof rawPath !== "string") {
    throw new Error("Invalid readFile path");
  }

  const normalized = normalizePathSeparators(rawPath).trim();
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    !isIndexableWorkspacePath(normalized)
  ) {
    throw new Error("Invalid readFile path");
  }

  const folders = vscodeApi.workspace.workspaceFolders;
  if (!folders || folders.length !== 1) {
    throw new Error("A single workspace folder is required");
  }
  let uri = folders[0]!.uri;
  for (const [index, part] of parts.entries()) {
    uri = vscodeApi.Uri.joinPath(uri, part);
    try {
      const stat = await vscodeApi.workspace.fs.stat(uri);
      if ((stat.type & vscodeApi.FileType.SymbolicLink) !== 0 || (index === parts.length - 1 && (stat.type & vscodeApi.FileType.Directory) !== 0)) {
        throw new Error("Invalid readFile path");
      }
    } catch (error) {
      if (isFileNotFound(error) && index === parts.length - 1) {
        continue;
      }
      throw new Error("Invalid readFile path");
    }
  }
  return uri;
}

async function stageProposal(vscodeApi: VsCodeEditApi, changes: readonly EditOperation[]): Promise<PlannedChange[]> {
  const snapshots = new Map<string, Snapshot>();
  const replacementTargets = new Map<string, string>();
  const exclusivePaths = new Set<string>();
  const plan: PlannedChange[] = [];

  for (const change of changes) {
    if (change.kind === "replace") {
      const uri = await resolveWorkspaceFileUri(vscodeApi, change.path);
      const path = normalizeWorkspacePath(change.path);
      if (exclusivePaths.has(path)) {
        throw new Error("Invalid edit proposal: conflicting file operations");
      }
      if (change.oldText.length === 0) {
        throw new Error("Invalid replace operation: oldText must not be empty");
      }
      assertText(change.oldText);
      assertText(change.newText);

      const snapshot = await getSnapshot(vscodeApi, snapshots, path, uri);
      const current = replacementTargets.get(path) ?? snapshot.content;
      const firstMatch = current.indexOf(change.oldText);
      if (firstMatch < 0 || current.indexOf(change.oldText, firstMatch + change.oldText.length) >= 0) {
        throw new Error("Invalid replace operation: oldText must match exactly once");
      }
      replacementTargets.set(path, `${current.slice(0, firstMatch)}${change.newText}${current.slice(firstMatch + change.oldText.length)}`);
      if (!plan.some((item) => item.kind === "replace" && item.path === path)) {
        plan.push({ kind: "replace", path, source: snapshot, target: "" });
      }
      continue;
    }

    if (change.kind === "create") {
      const uri = await resolveWorkspaceFileUri(vscodeApi, change.path);
      const path = normalizeWorkspacePath(change.path);
      reserveExclusivePath(exclusivePaths, replacementTargets, path);
      assertText(change.content);
      await assertMissing(vscodeApi, uri);
      plan.push({ kind: "create", path, content: change.content, uri });
      continue;
    }

    if (change.kind === "rename") {
      const source = await resolveWorkspaceFileUri(vscodeApi, change.from);
      const target = await resolveWorkspaceFileUri(vscodeApi, change.to);
      const from = normalizeWorkspacePath(change.from);
      const to = normalizeWorkspacePath(change.to);
      if (from === to) {
        throw new Error("Invalid edit proposal: rename paths must differ");
      }
      reserveExclusivePath(exclusivePaths, replacementTargets, from);
      reserveExclusivePath(exclusivePaths, replacementTargets, to);
      assertSavedWorkspaceDocument(vscodeApi, source);
      const sourceSnapshot = await getSnapshot(vscodeApi, snapshots, from, source);
      await assertMissing(vscodeApi, target);
      plan.push({ kind: "rename", from, to, source: sourceSnapshot, target });
      continue;
    }

    if (change.kind === "delete") {
      const uri = await resolveWorkspaceFileUri(vscodeApi, change.path);
      const path = normalizeWorkspacePath(change.path);
      reserveExclusivePath(exclusivePaths, replacementTargets, path);
      assertSavedWorkspaceDocument(vscodeApi, uri);
      plan.push({ kind: "delete", source: await getSnapshot(vscodeApi, snapshots, path, uri) });
      continue;
    }

    throw new Error("Invalid applyEdit operation");
  }

  for (const item of plan) {
    if (item.kind === "replace") {
      item.target = replacementTargets.get(item.path)!;
    }
  }
  return plan;
}

function reserveExclusivePath(exclusivePaths: Set<string>, replacements: ReadonlyMap<string, string>, path: string): void {
  if (exclusivePaths.has(path) || replacements.has(path)) {
    throw new Error("Invalid edit proposal: conflicting file operations");
  }
  exclusivePaths.add(path);
}

function assertText(value: string): void {
  if (value.includes("\0")) {
    throw new Error("Binary files are not supported");
  }
}

async function getSnapshot(
  vscodeApi: VsCodeEditApi,
  snapshots: Map<string, Snapshot>,
  path: string,
  uri: vscode.Uri,
): Promise<Snapshot> {
  const existing = snapshots.get(path);
  if (existing) {
    return existing;
  }

  const content = await readWorkspaceText(vscodeApi, uri);
  const snapshot = { path, uri, content };
  snapshots.set(path, snapshot);
  return snapshot;
}

export async function readWorkspaceText(vscodeApi: VsCodeEditApi, uri: vscode.Uri): Promise<string> {
  const openDocument = vscodeApi.workspace.textDocuments.find((document) => sameWorkspaceUri(document.uri, uri));
  if (openDocument) {
    const content = openDocument.getText();
    assertText(content);
    return content;
  }
  try {
    const bytes = await vscodeApi.workspace.fs.readFile(uri);
    if (bytes.includes(0)) {
      throw new Error("Binary files are not supported");
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message === "Binary files are not supported") {
      throw error;
    }
    throw new Error("Unable to read workspace file");
  }
}

async function assertMissing(vscodeApi: VsCodeEditApi, uri: vscode.Uri): Promise<void> {
  assertSavedWorkspaceDocument(vscodeApi, uri);
  try {
    await vscodeApi.workspace.fs.readFile(uri);
  } catch (error) {
    if (isFileNotFound(error)) {
      return;
    }
    throw new Error("Unable to inspect workspace file");
  }
  throw new Error("Invalid edit proposal: file already exists");
}

export function assertSavedWorkspaceDocument(vscodeApi: VsCodeEditApi, uri: vscode.Uri): void {
  if (vscodeApi.workspace.textDocuments.some((document) => sameWorkspaceUri(document.uri, uri) && document.isDirty)) {
    throw new Error("Workspace file has unsaved changes");
  }
}

function sameWorkspaceUri(left: vscode.Uri, right: vscode.Uri): boolean {
  if (left.scheme === "file" && right.scheme === "file") {
    return left.fsPath.toLocaleLowerCase() === right.fsPath.toLocaleLowerCase();
  }
  return left.toString() === right.toString();
}

function isFileNotFound(error: unknown): boolean {
  if (error instanceof Error && /file\s*not\s*found|enoent/i.test(error.message)) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "FileNotFound" || code === "ENOENT";
}

async function openPreviews(
  vscodeApi: VsCodeEditApi,
  previewContents: Map<string, string>,
  proposalId: string,
  plan: readonly PlannedChange[],
): Promise<void> {
  for (const item of plan) {
    const originalPath = item.kind === "create" ? item.path : item.source.path;
    const targetPath = item.kind === "rename" ? item.to : originalPath;
    const originalContent = item.kind === "create" ? "" : item.source.content;
    const targetContent = item.kind === "replace"
      ? item.target
      : item.kind === "create"
        ? item.content
        : item.kind === "delete"
          ? ""
          : item.source.content;
    const title = item.kind === "rename" ? `${item.from} -> ${item.to}` : originalPath;
    const original = addPreview(vscodeApi, previewContents, proposalId, originalPath, "original", originalContent);
    const target = addPreview(vscodeApi, previewContents, proposalId, targetPath, "target", targetContent);
    await vscodeApi.commands.executeCommand("vscode.diff", original, target, `LoopAgent: ${title}`);
    if (vscodeApi.workspace.getConfiguration("diffEditor", target).get("renderSideBySide", true)) {
      await vscodeApi.commands.executeCommand("toggle.diff.renderSideBySide", target);
    }
  }
}

function addPreview(
  vscodeApi: VsCodeEditApi,
  previewContents: Map<string, string>,
  proposalId: string,
  path: string,
  side: "original" | "target",
  content: string,
): vscode.Uri {
  const uri = vscodeApi.Uri.parse(`${PREVIEW_SCHEME}:/${proposalId}/${side}/${encodeURIComponent(path)}`);
  previewContents.set(uri.toString(), content);
  return uri;
}

async function snapshotsStillMatch(vscodeApi: VsCodeEditApi, plan: readonly PlannedChange[]): Promise<boolean> {
  for (const item of plan) {
    if (item.kind === "create") {
      if (!(await pathStillMatches(vscodeApi, item.path, item.uri))) {
        return false;
      }
      try {
        await assertMissing(vscodeApi, item.uri);
      } catch {
        return false;
      }
      continue;
    }
    const snapshot = item.source;
    if (!(await pathStillMatches(vscodeApi, snapshot.path, snapshot.uri))) {
      return false;
    }
    if (item.kind === "rename") {
      if (!(await pathStillMatches(vscodeApi, item.to, item.target))) {
        return false;
      }
      try {
        await assertMissing(vscodeApi, item.target);
      } catch {
        return false;
      }
    }
    try {
      if ((await readWorkspaceText(vscodeApi, snapshot.uri)) !== snapshot.content) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function pathStillMatches(vscodeApi: VsCodeEditApi, path: string, expectedUri: vscode.Uri): Promise<boolean> {
  try {
    return sameWorkspaceUri(await resolveWorkspaceFileUri(vscodeApi, path), expectedUri);
  } catch {
    return false;
  }
}

function createWorkspaceEdit(vscodeApi: VsCodeEditApi, plan: readonly PlannedChange[]): vscode.WorkspaceEdit {
  const edit = new vscodeApi.WorkspaceEdit();
  for (const item of plan) {
    if (item.kind === "replace") {
      edit.replace(item.source.uri, fullDocumentRange(vscodeApi, item.source.content), item.target);
    } else if (item.kind === "create") {
      edit.createFile(item.uri);
      edit.insert(item.uri, new vscodeApi.Position(0, 0), item.content);
    } else if (item.kind === "rename") {
      edit.renameFile(item.source.uri, item.target);
    } else {
      edit.deleteFile(item.source.uri);
    }
  }
  return edit;
}

function fullDocumentRange(vscodeApi: VsCodeEditApi, content: string): vscode.Range {
  const lines = content.split(/\r?\n/);
  return new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(lines.length - 1, lines.at(-1)!.length));
}

function normalizeWorkspacePath(rawPath: string): string {
  return normalizePathSeparators(rawPath).trim();
}
