import fs from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import {
  collectCodeRuntimeContext,
  type CodeRuntimeContext,
  type CodeRuntimeContextOptions,
  type CodeRuntimeContextSource,
  type RuntimeContextSeverity,
  type RuntimeProjectFile,
  type RuntimeTextDocument,
} from "./codeRuntimeContext";

const PROJECT_FILE_CANDIDATES: Array<Pick<RuntimeProjectFile, "path" | "kind">> = [
  { path: "package.json", kind: "manifest" },
  { path: "tsconfig.json", kind: "config" },
  { path: "README.md", kind: "doc" },
  { path: "docs/development.md", kind: "doc" },
];

const MAX_PROJECT_FILE_BYTES = 100_000;

export async function collectVsCodeRuntimeContext(
  options: CodeRuntimeContextOptions = {},
): Promise<CodeRuntimeContext> {
  return collectCodeRuntimeContext(await createVsCodeRuntimeContextSource(), options);
}

async function createVsCodeRuntimeContextSource(): Promise<CodeRuntimeContextSource> {
  const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const activeEditor = vscode.window.activeTextEditor;

  return {
    workspace: {
      name: vscode.workspace.name,
      roots,
    },
    activeEditor: activeEditor
      ? {
          document: toRuntimeDocument(activeEditor.document),
          cursor: {
            line: activeEditor.selection.active.line + 1,
            character: activeEditor.selection.active.character + 1,
          },
          selection: activeEditor.selection.isEmpty
            ? undefined
            : {
                startLine: activeEditor.selection.start.line + 1,
                startCharacter: activeEditor.selection.start.character + 1,
                endLine: activeEditor.selection.end.line + 1,
                endCharacter: activeEditor.selection.end.character + 1,
                text: activeEditor.document.getText(activeEditor.selection),
              },
        }
      : undefined,
    visibleEditors: [],
    openTabs: [],
    projectFiles: await readProjectFiles(roots),
    diagnostics: vscode.languages
      .getDiagnostics()
      .flatMap(([uri, diagnostics]) =>
        diagnostics.map((diagnostic) => ({
          path: uri.fsPath,
          severity: toRuntimeSeverity(diagnostic.severity),
          line: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
          message: diagnostic.message,
        })),
      ),
  };
}

function toRuntimeDocument(document: vscode.TextDocument): RuntimeTextDocument {
  return {
    path: document.uri.fsPath,
    languageId: document.languageId,
    text: document.getText(),
    isDirty: document.isDirty,
  };
}

function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  if (tab.input instanceof vscode.TabInputText) {
    return tab.input.uri;
  }

  return undefined;
}

function getLanguageIdForUri(uri: vscode.Uri): string | undefined {
  const visibleEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
  return visibleEditor?.document.languageId;
}

async function readProjectFiles(roots: string[]): Promise<RuntimeProjectFile[]> {
  const files: RuntimeProjectFile[] = [];

  for (const root of roots) {
    for (const candidate of PROJECT_FILE_CANDIDATES) {
      const filePath = path.join(root, candidate.path);
      const text = await readSmallTextFile(filePath);

      if (text === undefined) {
        continue;
      }

      files.push({
        path: filePath,
        kind: candidate.kind,
        text,
      });
    }
  }

  return files;
}

async function readSmallTextFile(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);

    if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) {
      return undefined;
    }

    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function toRuntimeSeverity(severity: vscode.DiagnosticSeverity): RuntimeContextSeverity {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}
