import { describe, expect, it } from "vitest";

import { collectCodeRuntimeContext } from "../src/extension/runtime/codeRuntimeContext";

const workspaceRoot = "E:\\zz\\loopagent-vscode";

describe("collectCodeRuntimeContext", () => {
  it("uses selected text before a cursor snippet", () => {
    const context = collectCodeRuntimeContext(
      {
        workspace: {
          name: "LoopAgent",
          roots: [workspaceRoot],
        },
        activeEditor: {
          document: {
            path: `${workspaceRoot}\\src\\shared\\messages.ts`,
            languageId: "typescript",
            text: ["type A = string;", "const selected = true;", "const after = false;"].join("\n"),
            isDirty: true,
          },
          cursor: {
            line: 2,
            character: 7,
          },
          selection: {
            startLine: 2,
            startCharacter: 1,
            endLine: 2,
            endCharacter: 23,
            text: "const selected = true;",
          },
        },
        projectFiles: [
          {
            path: `${workspaceRoot}\\package.json`,
            kind: "manifest",
            text: JSON.stringify({
              name: "loopagent-vscode",
              scripts: { test: "vitest run", compile: "node esbuild.js" },
              dependencies: { react: "^19.2.7" },
              devDependencies: { vitest: "^4.1.9" },
            }),
          },
        ],
      },
      { maxChars: 2_000, now: "2026-07-07T00:00:00.000Z" },
    );

    expect(context.workspace).toEqual({
      name: "LoopAgent",
      roots: ["loopagent-vscode"],
    });
    expect(context.activeEditor?.path).toBe("src/shared/messages.ts");
    expect(context.activeEditor?.selection?.text).toBe("const selected = true;");
    expect(context.activeEditor?.snippet).toBeUndefined();
    expect(context.projectFiles).toEqual([
      expect.objectContaining({
        path: "package.json",
        kind: "manifest",
        summary: expect.stringContaining("name: loopagent-vscode"),
      }),
    ]);
    expect(context.budget.truncated).toBe(false);
  });

  it("collects a nearby snippet when there is no selection", () => {
    const context = collectCodeRuntimeContext(
      {
        workspace: {
          roots: [workspaceRoot],
        },
        activeEditor: {
          document: {
            path: `${workspaceRoot}\\src\\extension.ts`,
            languageId: "typescript",
            text: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"),
          },
          cursor: {
            line: 4,
            character: 1,
          },
        },
      },
      { snippetRadiusLines: 1, now: "2026-07-07T00:00:00.000Z" },
    );

    expect(context.activeEditor?.snippet).toEqual({
      startLine: 3,
      endLine: 5,
      text: ["line 3", "line 4", "line 5"].join("\n"),
      truncated: false,
    });
  });

  it("filters sensitive paths, excluded directories, and low severity diagnostics", () => {
    const context = collectCodeRuntimeContext(
      {
        workspace: {
          roots: [workspaceRoot],
        },
        visibleEditors: [
          {
            path: `${workspaceRoot}\\src\\extension.ts`,
            languageId: "typescript",
            text: "export {};",
          },
          {
            path: `${workspaceRoot}\\node_modules\\left-pad\\index.js`,
            languageId: "javascript",
            text: "module.exports = {};",
          },
          {
            path: `${workspaceRoot}\\.env`,
            languageId: "dotenv",
            text: "IGNORED=value",
          },
        ],
        openTabs: [
          {
            path: `${workspaceRoot}\\src\\extension.ts`,
            languageId: "typescript",
            isDirty: false,
          },
          {
            path: `${workspaceRoot}\\.local-vscode-user-data\\User\\settings.json`,
            languageId: "json",
          },
        ],
        projectFiles: [
          {
            path: `${workspaceRoot}\\README.md`,
            kind: "doc",
            text: "# LoopAgent",
          },
          {
            path: `${workspaceRoot}\\secrets\\api-token.txt`,
            kind: "doc",
            text: "token",
          },
        ],
        diagnostics: [
          {
            path: `${workspaceRoot}\\src\\extension.ts`,
            severity: "error",
            line: 12,
            character: 3,
            message: "Cannot find name",
          },
          {
            path: `${workspaceRoot}\\src\\extension.ts`,
            severity: "information",
            line: 14,
            character: 1,
            message: "Informational only",
          },
        ],
      },
      { now: "2026-07-07T00:00:00.000Z" },
    );

    expect(context.visibleEditors).toEqual([
      expect.objectContaining({
        path: "src/extension.ts",
      }),
    ]);
    expect(context.openTabs).toEqual([
      expect.objectContaining({
        path: "src/extension.ts",
      }),
    ]);
    expect(context.projectFiles).toEqual([
      expect.objectContaining({
        path: "README.md",
      }),
    ]);
    expect(context.diagnostics).toEqual([
      {
        path: "src/extension.ts",
        severity: "error",
        line: 12,
        character: 3,
        message: "Cannot find name",
      },
    ]);
  });
});
