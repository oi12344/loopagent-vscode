import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import type { EditFileStat } from "../../shared/messages";
import { isIndexableWorkspacePath, normalizePathSeparators } from "../intelligence/indexing/workspaceFilePolicy";

export type EditOperation =
  | { kind: "replace"; path: string; oldText: string; newText: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string };

export type { EditFileStat };

export type EditApplicationNotice = {
  notificationId: string;
  files: string[];
  /** 每个文件的增删行统计，供通知 UI 展示 */
  fileStats: EditFileStat[];
};

/** 改动写入工作区后触发的通知；不返回任何值，不阻塞 apply 的完成 */
export type EditApplicationNotifier = (notice: EditApplicationNotice) => void;

export type EditPreviewServiceOptions = {
  /** 改动应用后的通知回调；默认不通知（用于测试等无 UI 场景） */
  notify?: EditApplicationNotifier;
};

export type EditPreviewService = {
  /** 直接把改动写入工作区，返回结果后再异步通知用户；不等待任何审批 */
  apply(changes: readonly EditOperation[], signal: AbortSignal): Promise<string>;
  /** 打开某次已应用改动里指定文件的 diff 预览（原始内容 vs 应用后内容） */
  openFilePreview(notificationId: string, path: string): Promise<void>;
  /** 撤销某次已应用改动里的部分或全部文件；paths 为空时撤销该次改动的全部文件 */
  revertFiles(notificationId: string, paths: readonly string[]): Promise<string>;
  /** 撤销上一次成功应用的改动；无可撤销内容时返回提示 */
  undoLast(): Promise<string>;
  dispose(): void;
};

export type VsCodeEditApi = {
  Uri: Pick<typeof vscode.Uri, "joinPath" | "parse">;
  FileType: Pick<typeof vscode.FileType, "Directory" | "SymbolicLink">;
  WorkspaceEdit: typeof vscode.WorkspaceEdit;
  Position: typeof vscode.Position;
  Range: typeof vscode.Range;
  commands: Pick<typeof vscode.commands, "executeCommand">;
  window?: {
    tabGroups: Pick<typeof vscode.window.tabGroups, "all" | "close">;
  };
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

export function createEditPreviewService(
  vscodeApi: VsCodeEditApi,
  options: EditPreviewServiceOptions = {},
): EditPreviewService {
  const previewContents = new Map<string, string>();
  /** notificationId -> 该次改动里仍未被撤销的文件计划 */
  const activeNotifications = new Map<string, PlannedChange[]>();
  let lastNotificationId: string | undefined;
  const registrations = [
    vscodeApi.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent(uri) {
        return previewContents.get(uri.toString()) ?? "";
      },
    }),
  ];
  const notify = options.notify ?? (() => {});

  async function performRevert(notificationId: string | undefined, paths: readonly string[]): Promise<string> {
    if (!notificationId) {
      return "Nothing to undo.";
    }
    const plan = activeNotifications.get(notificationId);
    if (!plan || plan.length === 0) {
      return "Nothing to undo.";
    }
    const targets = paths.length === 0 ? plan : plan.filter((item) => paths.includes(planItemPath(item)));
    if (targets.length === 0) {
      return "Nothing to undo.";
    }

    const reverse = createReverseWorkspaceEdit(vscodeApi, targets);
    if (!(await vscodeApi.workspace.applyEdit(reverse))) {
      return "Revert could not be applied.";
    }

    const targetSet = new Set(targets);
    const remaining = plan.filter((item) => !targetSet.has(item));
    activeNotifications.set(notificationId, remaining);
    return "Changes were undone.";
  }

  return {
    async apply(changes, signal) {
      if (changes.length === 0) {
        throw new Error("Invalid applyEdit input: changes must not be empty");
      }
      if (signal.aborted) {
        return "Changes were cancelled.";
      }

      const plan = await stageProposal(vscodeApi, changes);
      if (signal.aborted) {
        return "Changes were cancelled.";
      }

      const edit = createWorkspaceEdit(vscodeApi, plan);
      if (!(await vscodeApi.workspace.applyEdit(edit))) {
        return "Changes could not be applied.";
      }

      const notificationId = randomUUID();
      activeNotifications.set(notificationId, plan);
      lastNotificationId = notificationId;
      notify({
        notificationId,
        files: plan.map(planItemPath),
        fileStats: plan.map(computePlanStat),
      });
      return "Changes were applied.";
    },
    async undoLast() {
      return performRevert(lastNotificationId, []);
    },
    async revertFiles(notificationId, paths) {
      return performRevert(notificationId, paths);
    },
    async openFilePreview(notificationId, path) {
      const plan = activeNotifications.get(notificationId);
      const item = plan?.find((planItem) => planItemPath(planItem) === path);
      if (!item) {
        return;
      }
      await openPreview(vscodeApi, previewContents, notificationId, item);
    },
    dispose() {
      previewContents.clear();
      activeNotifications.clear();
      for (const registration of registrations) registration.dispose();
    },
  };
}

function planItemPath(item: PlannedChange): string {
  return item.kind === "create" ? item.path : item.kind === "rename" ? item.to : item.source.path;
}

function computePlanStat(item: PlannedChange): EditFileStat {
  const path = planItemPath(item);
  const originalContent = item.kind === "create" ? "" : item.source.content;
  const targetContent =
    item.kind === "replace"
      ? item.target
      : item.kind === "create"
        ? item.content
        : item.kind === "delete"
          ? ""
          : item.source.content;
  return { path, ...computeLineStats(originalContent, targetContent) };
}

/**
 * 统计从 original 到 target 的增删行数。
 * added = target 中新增的行数，removed = original 中被移除的行数。
 */
export function computeLineStats(original: string, target: string): { added: number; removed: number } {
  const originalLines = splitLines(original);
  const targetLines = splitLines(target);
  const common = longestCommonSubsequenceLength(originalLines, targetLines);
  return {
    added: targetLines.length - common,
    removed: originalLines.length - common,
  };
}

/** 逐行相等比较的 LCS 长度，滚动数组优化到 O(min(m,n)) 空间。 */
function longestCommonSubsequenceLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  // 让 b 为较短的一维，压缩滚动数组宽度
  const [rows, cols] = a.length >= b.length ? [a, b] : [b, a];
  let previous = new Array<number>(cols.length + 1).fill(0);
  let current = new Array<number>(cols.length + 1).fill(0);
  for (let i = 1; i <= rows.length; i += 1) {
    for (let j = 1; j <= cols.length; j += 1) {
      current[j] = rows[i - 1] === cols[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[cols.length]!;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r\n|\r|\n/);
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
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder is open");
  }

  // 逐 folder 尝试，取第一个文件实际存在的；都不存在时回落到第一个 folder（用于 create 操作）
  let fallbackUri: vscode.Uri | undefined;
  for (const folder of folders) {
    const candidate = await tryResolveInFolder(vscodeApi, folder.uri, parts);
    if (candidate === "invalid") {
      throw new Error("Invalid readFile path");
    }
    if (candidate !== null) {
      return candidate;
    }
    // null = 文件不存在于此 folder，记录第一个作为 fallback（create 路径）
    if (fallbackUri === undefined) {
      fallbackUri = buildFolderUri(vscodeApi, folder.uri, parts);
    }
  }
  if (fallbackUri !== undefined) {
    return fallbackUri;
  }
  throw new Error("Invalid readFile path");
}

/** 返回 null = 文件不存在但路径合法（create 可用），"invalid" = 路径非法，Uri = 命中 */
async function tryResolveInFolder(
  vscodeApi: VsCodeEditApi,
  root: vscode.Uri,
  parts: readonly string[],
): Promise<vscode.Uri | null | "invalid"> {
  let uri = root;
  for (const [index, part] of parts.entries()) {
    uri = vscodeApi.Uri.joinPath(uri, part);
    try {
      const stat = await vscodeApi.workspace.fs.stat(uri);
      if (
        (stat.type & vscodeApi.FileType.SymbolicLink) !== 0 ||
        (index === parts.length - 1 && (stat.type & vscodeApi.FileType.Directory) !== 0)
      ) {
        return "invalid";
      }
    } catch (error) {
      // 该 folder 下这一层路径不存在：既可能是文件尚未创建（最后一段），也可能是这个 folder
      // 压根没有这个子目录结构——两种情况都只表示"不在这个 folder 里"，交给下一个 folder 继续尝试。
      if (isFileNotFound(error)) {
        return null;
      }
      return "invalid";
    }
  }
  return uri;
}

function buildFolderUri(vscodeApi: VsCodeEditApi, root: vscode.Uri, parts: readonly string[]): vscode.Uri {
  let uri = root;
  for (const part of parts) {
    uri = vscodeApi.Uri.joinPath(uri, part);
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
      const { match, matchCount } = findTextMatch(current, change.oldText);
      if (match === null) {
        throw new Error(matchCount === 0
          ? "Invalid replace operation: oldText not found in file"
          : `Invalid replace operation: oldText matches ${matchCount} times (expected exactly 1)`);
      }
      const detectedLineEnding = detectLineEnding(current);
      const normalizedNewText = normalizeLineEndings(change.newText, detectedLineEnding);
      replacementTargets.set(path, `${current.slice(0, match.index)}${normalizedNewText}${current.slice(match.index + match.text.length)}`);
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

async function openPreview(
  vscodeApi: VsCodeEditApi,
  previewContents: Map<string, string>,
  proposalId: string,
  item: PlannedChange,
): Promise<void> {
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

/** 构造上一次已应用改动的反向 edit：replace 换回原内容、create→删、delete→建、rename 反向。 */
function createReverseWorkspaceEdit(vscodeApi: VsCodeEditApi, plan: readonly PlannedChange[]): vscode.WorkspaceEdit {
  const edit = new vscodeApi.WorkspaceEdit();
  for (const item of plan) {
    if (item.kind === "replace") {
      // 当前文件内容是 target，把整篇换回原始 source.content
      edit.replace(item.source.uri, fullDocumentRange(vscodeApi, item.target), item.source.content);
    } else if (item.kind === "create") {
      edit.deleteFile(item.uri);
    } else if (item.kind === "rename") {
      edit.renameFile(item.target, item.source.uri);
    } else {
      edit.createFile(item.source.uri);
      edit.insert(item.source.uri, new vscodeApi.Position(0, 0), item.source.content);
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

function detectLineEnding(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string, targetEnding: "\r\n" | "\n"): string {
  return text.replace(/\r\n|\r|\n/g, targetEnding);
}

function findTextMatch(haystack: string, needle: string): { match: { index: number; text: string } | null; matchCount: number } {
  const variants = [
    needle,
    normalizeLineEndings(needle, "\r\n"),
    normalizeLineEndings(needle, "\n"),
  ];
  const uniqueVariants = [...new Set(variants)];

  let totalMatches = 0;
  let firstMatch = null;

  for (const variant of uniqueVariants) {
    let index = 0;
    while ((index = haystack.indexOf(variant, index)) !== -1) {
      if (firstMatch === null) {
        firstMatch = { index, text: variant };
      }
      totalMatches += 1;
      index += variant.length;
    }
  }

  return { match: totalMatches === 1 ? firstMatch : null, matchCount: totalMatches };
}
