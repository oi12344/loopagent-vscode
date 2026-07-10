import { describe, expect, it, vi } from "vitest";

import { createWorkspaceIntelligence } from "../../src/extension/intelligence/workspaceIntelligence";

describe("workspace AST integration", () => {
  it("releases a parsed tree after extraction", async () => {
    const deleteTree = vi.fn();
    const intelligence = createWorkspaceIntelligence({
      parserRuntime: {
        async parse(filePath, languageId, text) {
          return {
            filePath,
            languageId,
            text,
            tree: {
              rootNode: {
                type: "program",
                text,
                isNamed: true,
                hasError: false,
                startPosition: { row: 0, column: 0 },
                endPosition: { row: 0, column: text.length },
                namedChildren: [],
                childForFieldName: () => null,
              },
              delete: deleteTree,
            },
            diagnostics: [],
          };
        },
      },
      readWorkspaceFiles: async () => [
        { path: "src/a.ts", languageId: "typescript", text: "function run() {}" },
      ],
      readSourceRange: () => "function run() {}",
    });

    await intelligence.buildCodeIntelligencePrompt("run");

    expect(deleteTree).toHaveBeenCalledOnce();
  });

  it("records each parser diagnostic exactly once", async () => {
    const warning = { filePath: "src/a.ts", severity: "warning" as const, message: "fixture warning" };
    const intelligence = createWorkspaceIntelligence({
      parserRuntime: {
        async parse(filePath, languageId, text) {
          return { filePath, languageId, text, tree: undefined, diagnostics: [warning] };
        },
      },
      readWorkspaceFiles: async () => [
        { path: "src/a.ts", languageId: "typescript", text: "function run() {}" },
      ],
      readSourceRange: () => "function run() {}",
    });

    await intelligence.buildCodeIntelligencePrompt("run");

    expect(intelligence.getDiagnostics().filter((diagnostic) => diagnostic.message === warning.message)).toHaveLength(1);
  });

  it("uses resolved import paths when duplicate symbol names exist", async () => {
    const sources = new Map([
      [
        "src/a.ts",
        [
          'import { helper as importedHelper } from "./b";',
          "export function run() {",
          "  importedHelper();",
          "}",
        ].join("\n"),
      ],
      ["src/b.ts", "export function helper() { return 'b'; }"],
      ["src/c.ts", "export function helper() { return 'c'; }"],
    ]);
    const intelligence = createWorkspaceIntelligence({
      readWorkspaceFiles: async () =>
        [...sources].map(([path, text]) => ({ path, languageId: "typescript", text })),
      readSourceRange: (filePath, startLine, endLine) =>
        readSourceRange(sources.get(filePath) ?? "", startLine, endLine),
    });

    const prompt = await intelligence.buildCodeIntelligencePrompt("run");

    expect(prompt).toContain("src/b.ts");
    expect(prompt).not.toContain("src/c.ts");
  });
});

function readSourceRange(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
}
