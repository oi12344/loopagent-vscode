import { describe, expect, it } from "vitest";

import {
  createEmptyWorkspaceIntelligence,
  createWorkspaceIntelligence,
} from "../../src/extension/intelligence/workspaceIntelligence";

describe("createWorkspaceIntelligence", () => {
  it("provides an empty implementation for optional prompt injection", async () => {
    const intelligence = createEmptyWorkspaceIntelligence();

    await expect(intelligence.buildCodeIntelligencePrompt("anything")).resolves.toBe("");
    expect(intelligence.getStatus()).toBe("ready");
    expect(intelligence.getDiagnostics()).toEqual([]);
  });

  it("indexes source files and returns a code intelligence prompt", async () => {
    const intelligence = createWorkspaceIntelligence({
      readWorkspaceFiles: async () => [
        {
          path: "src/providerRegistry.ts",
          languageId: "typescript",
          text: [
            'import { createModelRunner } from "./modelRunner";',
            "export function createConfiguredAgentRunner() {",
            "  return createModelRunner();",
            "}",
          ].join("\n"),
        },
        {
          path: "src/modelRunner.ts",
          languageId: "typescript",
          text: "export function createModelRunner() { return {}; }",
        },
      ],
      readSourceRange: (filePath, startLine, endLine) => `${filePath}:${startLine}-${endLine}`,
    });

    const prompt = await intelligence.buildCodeIntelligencePrompt("configured runner");

    expect(prompt).toContain("代码语义索引上下文");
    expect(prompt).toContain("createConfiguredAgentRunner");
    expect(prompt).toContain("src/providerRegistry.ts");
    expect(intelligence.getStatus()).toBe("ready");
  });

  it("reuses cached parser results when file content is unchanged", async () => {
    let parseCalls = 0;
    const intelligence = createWorkspaceIntelligence({
      parserRuntime: {
        async parse(filePath, languageId, text) {
          parseCalls += 1;
          return { filePath, languageId, text, tree: undefined, diagnostics: [] };
        },
      },
      readWorkspaceFiles: async () => [
        { path: "src/a.ts", languageId: "typescript", text: "export function run() {}" },
      ],
      readSourceRange: () => "export function run() {}",
    });

    await intelligence.buildCodeIntelligencePrompt("run");
    await intelligence.buildCodeIntelligencePrompt("run");

    expect(parseCalls).toBe(1);
  });

  it("re-parses changed file content and exposes the new symbol", async () => {
    let parseCalls = 0;
    let text = "export function run() {}";
    const intelligence = createWorkspaceIntelligence({
      parserRuntime: {
        async parse(filePath, languageId, sourceText) {
          parseCalls += 1;
          return { filePath, languageId, text: sourceText, tree: undefined, diagnostics: [] };
        },
      },
      readWorkspaceFiles: async () => [{ path: "src/a.ts", languageId: "typescript", text }],
      readSourceRange: () => text,
    });

    await intelligence.buildCodeIntelligencePrompt("run");
    text = "export function renamed() {}";
    const prompt = await intelligence.buildCodeIntelligencePrompt("renamed");

    expect(parseCalls).toBe(2);
    expect(prompt).toContain("renamed");
  });

  it("skips oversized files and reports partial status without blocking prompts", async () => {
    const intelligence = createWorkspaceIntelligence({
      budgets: { maxFileBytes: 16 },
      readWorkspaceFiles: async () => [
        {
          path: "src/large.ts",
          languageId: "typescript",
          text: "export function createConfiguredAgentRunner() { return createModelRunner(); }",
        },
        {
          path: "src/small.ts",
          languageId: "typescript",
          text: "function ok() {}",
        },
      ],
      readSourceRange: (filePath, startLine, endLine) => `${filePath}:${startLine}-${endLine}`,
    });

    const prompt = await intelligence.buildCodeIntelligencePrompt("ok");

    expect(prompt).toContain("ok");
    expect(prompt).not.toContain("createConfiguredAgentRunner");
    expect(intelligence.getStatus()).toBe("partial");
    expect(intelligence.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/large.ts",
          severity: "warning",
        }),
      ]),
    );
  });

  it("includes function body calls for provider registry orchestration questions", async () => {
    const sources = new Map([
      [
        "src/extension/model/providerRegistry.ts",
        [
          'import { renderCodeRuntimeContextPrompt } from "../runtime/contextPrompt";',
          'import { collectVsCodeRuntimeContext } from "../runtime/vscodeRuntimeContext";',
          'import { createModelRunner } from "./modelRunner";',
          "export async function createConfiguredAgentRunner() {",
          "  return createModelRunner({",
          "    systemPromptProvider: async (request) => {",
          "      const runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());",
          "      const codePrompt = await workspaceIntelligence.buildCodeIntelligencePrompt(request.task);",
          "      return [runtimePrompt, codePrompt].filter(Boolean).join('\\n\\n');",
          "    },",
          "  });",
          "}",
        ].join("\n"),
      ],
    ]);
    const intelligence = createWorkspaceIntelligence({
      readWorkspaceFiles: async () => [
        {
          path: "src/extension/model/providerRegistry.ts",
          languageId: "typescript",
          text: sources.get("src/extension/model/providerRegistry.ts")!,
        },
      ],
      readSourceRange: (filePath, startLine, endLine) => readSourceRange(sources.get(filePath) ?? "", startLine, endLine),
    });

    const query =
      "providerRegistry.ts createConfiguredAgentRunner systemPromptProvider createModelRunner collectVsCodeRuntimeContext";
    const prompt = withoutQuery(await intelligence.buildCodeIntelligencePrompt(query), query);

    expect(prompt).toContain("createModelRunner");
    expect(prompt).toContain("collectVsCodeRuntimeContext");
    expect(prompt).toContain("renderCodeRuntimeContextPrompt");
    expect(prompt).toContain("workspaceIntelligence.buildCodeIntelligencePrompt");
  });

  it("prioritizes class method snippets for extension view provider questions", async () => {
    const sources = new Map([
      [
        "src/extension.ts",
        [
          "class LoopAgentChatViewProvider {",
          "  private readonly workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {",
          "    parserRuntime: createTreeSitterParserRuntime(),",
          "  });",
          "  private startRun(): void {",
          "    void createConfiguredAgentRunner(this.context, message.model, {",
          "      workspaceIntelligence: this.workspaceIntelligence,",
          "    });",
          "  }",
          "}",
        ].join("\n"),
      ],
      [
        "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
        "export function createVsCodeWorkspaceIntelligence() {}",
      ],
    ]);
    const intelligence = createWorkspaceIntelligence({
      readWorkspaceFiles: async () => [
        { path: "src/extension.ts", languageId: "typescript", text: sources.get("src/extension.ts")! },
        {
          path: "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
          languageId: "typescript",
          text: sources.get("src/extension/intelligence/vscodeWorkspaceIntelligence.ts")!,
        },
      ],
      readSourceRange: (filePath, startLine, endLine) => readSourceRange(sources.get(filePath) ?? "", startLine, endLine),
    });

    const query = "extension.ts LoopAgentChatViewProvider.startRun";
    const prompt = withoutQuery(await intelligence.buildCodeIntelligencePrompt(query), query);

    expect(prompt).toContain("src/extension.ts");
    expect(prompt).toContain("LoopAgentChatViewProvider.startRun");
    expect(prompt).toContain("workspaceIntelligence: this.workspaceIntelligence");
  });

  it("includes local cache state for VS Code workspace incremental refresh questions", async () => {
    const sources = new Map([
      [
        "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
        [
          "export function createVsCodeWorkspaceIntelligence() {",
          "  const sourceCache = new Map<string, string>();",
          "  const dirtyPaths = new Set<string>();",
          "  const deletedPaths = new Set<string>();",
          "  const watcher = vscodeApi.workspace.createFileSystemWatcher?.(SOURCE_INCLUDE_PATTERN);",
          "  watcher?.onDidChange((uri) => markDirty(uri));",
          "  watcher?.onDidDelete((uri) => markDeleted(uri));",
          "}",
        ].join("\n"),
      ],
    ]);
    const intelligence = createWorkspaceIntelligence({
      readWorkspaceFiles: async () => [
        {
          path: "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
          languageId: "typescript",
          text: sources.get("src/extension/intelligence/vscodeWorkspaceIntelligence.ts")!,
        },
      ],
      readSourceRange: (filePath, startLine, endLine) => readSourceRange(sources.get(filePath) ?? "", startLine, endLine),
    });

    const query = "createVsCodeWorkspaceIntelligence sourceCache dirtyPaths deletedPaths FileSystemWatcher";
    const prompt = withoutQuery(await intelligence.buildCodeIntelligencePrompt(query), query);

    expect(prompt).toContain("sourceCache");
    expect(prompt).toContain("dirtyPaths");
    expect(prompt).toContain("deletedPaths");
    expect(prompt).toContain("createFileSystemWatcher");
  });

});

function readSourceRange(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
}

function withoutQuery(prompt: string, query: string): string {
  return prompt.replace(query, "");
}
