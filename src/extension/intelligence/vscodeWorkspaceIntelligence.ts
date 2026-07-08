import {
  createWorkspaceIntelligence,
  type WorkspaceIntelligence,
  type WorkspaceIntelligenceBudgets,
  type WorkspaceSourceFile,
} from "./workspaceIntelligence";

type WorkspaceUri = {
  fsPath: string;
};

type WorkspaceFolder = {
  uri: WorkspaceUri;
  name: string;
  index: number;
};

type MaybePromise<T> = T | Promise<T> | PromiseLike<T>;

export type VsCodeWorkspaceApi = {
  workspace: {
    workspaceFolders?: readonly WorkspaceFolder[];
    findFiles(
      include: string,
      exclude?: string | null,
      maxResults?: number,
    ): MaybePromise<readonly WorkspaceUri[]>;
    fs: {
      readFile(uri: WorkspaceUri): MaybePromise<Uint8Array>;
    };
    asRelativePath?(pathOrUri: WorkspaceUri | string, includeWorkspaceFolder?: boolean): string;
  };
};

export type CreateVsCodeWorkspaceIntelligenceOptions = Partial<WorkspaceIntelligenceBudgets> & {
  maxFileBytes?: number;
  maxWorkspaceFiles?: number;
};

const DEFAULT_MAX_FILE_BYTES = 100_000;
const DEFAULT_MAX_WORKSPACE_FILES = 512;
const SOURCE_INCLUDE_PATTERN = "{**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.py}";
const SOURCE_EXCLUDE_PATTERN =
  "{**/node_modules/**,**/dist/**,**/.git/**,**/.local-vscode-*/**,**/.env,**/.env.*,**/*secret*,**/*token*,**/*api_key*,**/*apikey*}";

export function createVsCodeWorkspaceIntelligence(
  vscodeApi: VsCodeWorkspaceApi,
  options: CreateVsCodeWorkspaceIntelligenceOptions = {},
): WorkspaceIntelligence {
  const sourceCache = new Map<string, string>();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxWorkspaceFiles = options.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES;

  return createWorkspaceIntelligence({
    budgets: options,
    async readWorkspaceFiles() {
      sourceCache.clear();

      const workspaceRoots = getWorkspaceRoots(vscodeApi.workspace.workspaceFolders);
      const uris = await vscodeApi.workspace.findFiles(SOURCE_INCLUDE_PATTERN, SOURCE_EXCLUDE_PATTERN, maxWorkspaceFiles);
      const files: WorkspaceSourceFile[] = [];

      for (const uri of uris) {
        const relativePath = getWorkspaceRelativePath(vscodeApi, uri, workspaceRoots);
        if (!isIndexableWorkspacePath(relativePath)) {
          continue;
        }

        const languageId = detectWorkspaceLanguageId(relativePath);
        if (!languageId) {
          continue;
        }

        const bytes = await vscodeApi.workspace.fs.readFile(uri);
        if (bytes.byteLength > maxFileBytes) {
          continue;
        }

        const text = new TextDecoder().decode(bytes);
        const cacheKey = normalizePathSeparators(relativePath);
        sourceCache.set(cacheKey, text);
        files.push({ path: cacheKey, languageId, text });
      }

      return files;
    },
    readSourceRange(filePath, startLine, endLine) {
      return readSourceRangeFromText(sourceCache.get(normalizePathSeparators(filePath)) ?? "", startLine, endLine);
    },
  });
}

export function isIndexableWorkspacePath(filePath: string): boolean {
  const normalized = normalizePathSeparators(filePath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "";

  if (
    parts.some((part) => part === ".git" || part === "node_modules" || part === "dist" || part.startsWith(".local-vscode-"))
  ) {
    return false;
  }

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return false;
  }

  return !/(^|[._-])(secret|secrets|token|tokens|api[_-]?key|apikey|key)([._-]|$)/i.test(fileName);
}

export function detectWorkspaceLanguageId(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath).toLowerCase();
  if (normalized.endsWith(".tsx")) {
    return "typescriptreact";
  }
  if (normalized.endsWith(".ts")) {
    return "typescript";
  }
  if (normalized.endsWith(".jsx")) {
    return "javascriptreact";
  }
  if (normalized.endsWith(".js")) {
    return "javascript";
  }
  if (normalized.endsWith(".py")) {
    return "python";
  }
  return undefined;
}

export function normalizeWorkspaceRelativePath(filePath: string, workspaceRoots: readonly string[] = []): string {
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

function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
