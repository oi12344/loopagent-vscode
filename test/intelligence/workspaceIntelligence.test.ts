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
          return { filePath, languageId, text, tree: { ok: true }, diagnostics: [] };
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
          return { filePath, languageId, text: sourceText, tree: { ok: true }, diagnostics: [] };
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
});
