import path from "node:path";

export type RuntimeContextSeverity = "error" | "warning" | "information" | "hint";

export type RuntimeTextDocument = {
  path: string;
  languageId: string;
  text: string;
  isDirty?: boolean;
};

export type RuntimePosition = {
  line: number;
  character: number;
};

export type RuntimeSelection = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
};

export type RuntimeActiveEditor = {
  document: RuntimeTextDocument;
  cursor?: RuntimePosition;
  selection?: RuntimeSelection;
};

export type RuntimeTab = {
  path: string;
  languageId?: string;
  isDirty?: boolean;
  isPinned?: boolean;
};

export type RuntimeProjectFile = {
  path: string;
  kind: "manifest" | "config" | "doc";
  text: string;
};

export type RuntimeDiagnostic = {
  path: string;
  severity: RuntimeContextSeverity;
  line: number;
  character: number;
  message: string;
};

export type CodeRuntimeContextSource = {
  workspace?: {
    name?: string;
    roots: string[];
  };
  activeEditor?: RuntimeActiveEditor;
  visibleEditors?: RuntimeTextDocument[];
  openTabs?: RuntimeTab[];
  projectFiles?: RuntimeProjectFile[];
  diagnostics?: RuntimeDiagnostic[];
};

export type CodeRuntimeContextOptions = {
  maxChars?: number;
  snippetRadiusLines?: number;
  maxOpenTabs?: number;
  maxDiagnostics?: number;
  now?: string;
};

export type CodeRuntimeTextExcerpt = {
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
};

export type CodeRuntimeContext = {
  version: 1;
  collectedAt: string;
  workspace: {
    name?: string;
    roots: string[];
  };
  activeEditor?: {
    path: string;
    languageId: string;
    lineCount: number;
    cursor?: RuntimePosition;
    selection?: CodeRuntimeTextExcerpt;
    snippet?: CodeRuntimeTextExcerpt;
    isDirty?: boolean;
  };
  visibleEditors: Array<{
    path: string;
    languageId: string;
    isDirty?: boolean;
  }>;
  openTabs: RuntimeTab[];
  projectFiles: Array<{
    path: string;
    kind: RuntimeProjectFile["kind"];
    summary: string;
    truncated: boolean;
  }>;
  diagnostics: RuntimeDiagnostic[];
  budget: {
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
};

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SNIPPET_RADIUS_LINES = 80;
const DEFAULT_MAX_OPEN_TABS = 20;
const DEFAULT_MAX_DIAGNOSTICS = 20;

export function collectCodeRuntimeContext(
  source: CodeRuntimeContextSource,
  options: CodeRuntimeContextOptions = {},
): CodeRuntimeContext {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const budget = createTextBudget(maxChars);
  const roots = source.workspace?.roots ?? [];

  const context: CodeRuntimeContext = {
    version: 1,
    collectedAt: options.now ?? new Date().toISOString(),
    workspace: {
      name: source.workspace?.name,
      roots: roots.map(getRootName).filter((root) => root.length > 0),
    },
    visibleEditors: [],
    openTabs: [],
    projectFiles: [],
    diagnostics: [],
    budget: {
      maxChars,
      usedChars: 0,
      truncated: false,
    },
  };

  if (source.activeEditor && isAllowedContextPath(source.activeEditor.document.path)) {
    context.activeEditor = collectActiveEditor(source.activeEditor, roots, budget, options);
  }

  context.visibleEditors = uniqueByPath(source.visibleEditors ?? [], roots)
    .filter((document) => isAllowedContextPath(document.path))
    .map((document) => ({
      path: toWorkspaceRelativePath(document.path, roots),
      languageId: document.languageId,
      isDirty: document.isDirty,
    }));

  context.openTabs = uniqueByPath(source.openTabs ?? [], roots)
    .filter((tab) => isAllowedContextPath(tab.path))
    .slice(0, options.maxOpenTabs ?? DEFAULT_MAX_OPEN_TABS)
    .map((tab) => ({
      path: toWorkspaceRelativePath(tab.path, roots),
      languageId: tab.languageId,
      isDirty: tab.isDirty,
      isPinned: tab.isPinned,
    }));

  context.projectFiles = (source.projectFiles ?? [])
    .filter((projectFile) => isAllowedContextPath(projectFile.path))
    .map((projectFile) => {
      const summary = summarizeProjectFile(projectFile);
      const excerpt = budget.take(summary);

      return {
        path: toWorkspaceRelativePath(projectFile.path, roots),
        kind: projectFile.kind,
        summary: excerpt.text,
        truncated: excerpt.truncated,
      };
    })
    .filter((projectFile) => projectFile.summary.length > 0);

  context.diagnostics = (source.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning")
    .filter((diagnostic) => isAllowedContextPath(diagnostic.path))
    .slice(0, options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      ...diagnostic,
      path: toWorkspaceRelativePath(diagnostic.path, roots),
    }));

  context.budget = budget.snapshot();

  return context;
}

function collectActiveEditor(
  activeEditor: RuntimeActiveEditor,
  roots: string[],
  budget: TextBudget,
  options: CodeRuntimeContextOptions,
): NonNullable<CodeRuntimeContext["activeEditor"]> {
  const documentText = normalizeLineEndings(activeEditor.document.text);
  const lines = documentText.split("\n");
  const selectionText = normalizeLineEndings(activeEditor.selection?.text ?? "");
  const selection =
    selectionText.trim().length > 0 && activeEditor.selection
      ? createSelectionExcerpt(activeEditor.selection, selectionText, budget)
      : undefined;

  return {
    path: toWorkspaceRelativePath(activeEditor.document.path, roots),
    languageId: activeEditor.document.languageId,
    lineCount: lines.length,
    cursor: activeEditor.cursor,
    selection,
    snippet: selection
      ? undefined
      : createSnippetExcerpt(
          lines,
          activeEditor.cursor?.line ?? 1,
          options.snippetRadiusLines ?? DEFAULT_SNIPPET_RADIUS_LINES,
          budget,
        ),
    isDirty: activeEditor.document.isDirty,
  };
}

function createSelectionExcerpt(
  selection: RuntimeSelection,
  text: string,
  budget: TextBudget,
): CodeRuntimeTextExcerpt {
  const excerpt = budget.take(text);

  return {
    startLine: selection.startLine,
    endLine: selection.endLine,
    text: excerpt.text,
    truncated: excerpt.truncated,
  };
}

function createSnippetExcerpt(
  lines: string[],
  cursorLine: number,
  radiusLines: number,
  budget: TextBudget,
): CodeRuntimeTextExcerpt | undefined {
  if (lines.length === 0) {
    return undefined;
  }

  const safeCursorLine = clamp(cursorLine, 1, lines.length);
  const startLine = Math.max(1, safeCursorLine - radiusLines);
  const endLine = Math.min(lines.length, safeCursorLine + radiusLines);
  const excerpt = budget.take(lines.slice(startLine - 1, endLine).join("\n"));

  if (excerpt.text.length === 0) {
    return undefined;
  }

  return {
    startLine,
    endLine,
    text: excerpt.text,
    truncated: excerpt.truncated,
  };
}

function summarizeProjectFile(projectFile: RuntimeProjectFile): string {
  if (path.basename(projectFile.path).toLowerCase() === "package.json") {
    return summarizePackageJson(projectFile.text);
  }

  return normalizeLineEndings(projectFile.text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 30)
    .join("\n");
}

function summarizePackageJson(text: string): string {
  try {
    const manifest = JSON.parse(text) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const lines: string[] = [];

    if (typeof manifest.name === "string" && manifest.name.trim().length > 0) {
      lines.push(`name: ${manifest.name.trim()}`);
    }

    const scripts = objectKeys(manifest.scripts);
    if (scripts.length > 0) {
      lines.push(`scripts: ${scripts.join(", ")}`);
    }

    const dependencies = objectKeys(manifest.dependencies);
    if (dependencies.length > 0) {
      lines.push(`dependencies: ${dependencies.join(", ")}`);
    }

    const devDependencies = objectKeys(manifest.devDependencies);
    if (devDependencies.length > 0) {
      lines.push(`devDependencies: ${devDependencies.join(", ")}`);
    }

    return lines.join("\n");
  } catch {
    return normalizeLineEndings(text).slice(0, 2_000);
  }
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value).sort();
}

function isAllowedContextPath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const fileName = lowerParts[lowerParts.length - 1] ?? "";

  if (
    lowerParts.some(
      (part) => part === ".git" || part === "node_modules" || part === "dist" || part.startsWith(".local-vscode-"),
    )
  ) {
    return false;
  }

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return false;
  }

  return !/(^|[._-])(secret|secrets|token|tokens|api[_-]?key|apikey|key)([._-]|$)/i.test(fileName);
}

function uniqueByPath<T extends { path: string }>(items: T[], roots: string[]): T[] {
  const seen = new Set<string>();
  const uniqueItems: T[] = [];

  for (const item of items) {
    const relativePath = toWorkspaceRelativePath(item.path, roots);
    if (seen.has(relativePath)) {
      continue;
    }

    seen.add(relativePath);
    uniqueItems.push(item);
  }

  return uniqueItems;
}

function toWorkspaceRelativePath(filePath: string, roots: string[]): string {
  const normalizedPath = normalizePath(filePath);

  for (const root of roots) {
    const normalizedRoot = trimTrailingSlash(normalizePath(root));

    if (normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()) {
      return getRootName(root);
    }

    const prefix = `${normalizedRoot}/`;
    if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
      return normalizedPath.slice(prefix.length);
    }
  }

  return normalizedPath;
}

function getRootName(root: string): string {
  const normalizedRoot = trimTrailingSlash(normalizePath(root));
  return normalizedRoot.split("/").filter(Boolean).at(-1) ?? normalizedRoot;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type TextBudget = {
  take(text: string): { text: string; truncated: boolean };
  snapshot(): CodeRuntimeContext["budget"];
};

function createTextBudget(maxChars: number): TextBudget {
  let usedChars = 0;
  let truncated = false;

  return {
    take(text: string): { text: string; truncated: boolean } {
      const normalizedText = normalizeLineEndings(text);
      const remainingChars = Math.max(0, maxChars - usedChars);

      if (normalizedText.length <= remainingChars) {
        usedChars += normalizedText.length;
        return {
          text: normalizedText,
          truncated: false,
        };
      }

      truncated = true;
      usedChars += remainingChars;

      return {
        text: normalizedText.slice(0, remainingChars),
        truncated: true,
      };
    },
    snapshot(): CodeRuntimeContext["budget"] {
      return {
        maxChars,
        usedChars,
        truncated,
      };
    },
  };
}
