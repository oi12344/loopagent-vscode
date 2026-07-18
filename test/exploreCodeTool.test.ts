import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createExploreCodeTool } from "../src/extension/agent/exploreCodeTool";
import type { WorkspaceIntelligence } from "../src/extension/intelligence/workspaceIntelligence";

function createIntelligence(result: string | Error): WorkspaceIntelligence {
  return {
    buildCodeIntelligencePrompt: vi.fn(async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("createExploreCodeTool", () => {
  it("searches the workspace with a validated query", async () => {
    const intelligence = createIntelligence("provider registry context");
    const tool = createExploreCodeTool(intelligence);

    await expect(
      tool.invoke({
        request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
        input: { query: "provider registry" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ content: "provider registry context", evidence: [] });
    expect(intelligence.buildCodeIntelligencePrompt).toHaveBeenCalledWith("provider registry");
    expect(tool).toMatchObject({
      name: "exploreCode",
      inputSchema: expect.objectContaining({ additionalProperties: false }),
    });
  });

  it("returns file evidence with a workspace-relative path, line range, and SHA-256 -- never the source text itself", async () => {
    const snippetTexts = ["function readFile() {}", "function writeFile() {}"];
    const intelligence: WorkspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
      buildCodeIntelligenceResult: vi.fn(async () => ({
        prompt: "## 代码语义索引上下文",
        snippets: [
          { filePath: "src/a.ts", startLine: 10, endLine: 12, text: snippetTexts[0]! },
          { filePath: "src/b.ts", startLine: 20, endLine: 25, text: snippetTexts[1]! },
        ],
      })),
    };
    const tool = createExploreCodeTool(intelligence);

    const result = await tool.invoke({
      request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
      input: { query: "readFile" },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      content: "## 代码语义索引上下文",
      evidence: [
        { filePath: "src/a.ts", startLine: 10, endLine: 12, sha256: sha256(snippetTexts[0]!), required: true },
        { filePath: "src/b.ts", startLine: 20, endLine: 25, sha256: sha256(snippetTexts[1]!), required: true },
      ],
    });
    for (const entry of (result as { evidence: unknown[] }).evidence) {
      expect(JSON.stringify(entry)).not.toContain("function");
    }
  });

  it("caps evidence at the first four snippets", async () => {
    const snippets = Array.from({ length: 6 }, (_, index) => ({
      filePath: `src/file-${index}.ts`,
      startLine: index + 1,
      endLine: index + 2,
      text: `snippet ${index}`,
    }));
    const intelligence: WorkspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
      buildCodeIntelligenceResult: vi.fn(async () => ({ prompt: "context", snippets })),
    };
    const tool = createExploreCodeTool(intelligence);

    const result = await tool.invoke({
      request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
      input: { query: "file" },
      signal: new AbortController().signal,
    });

    expect((result as { evidence: unknown[] }).evidence).toHaveLength(4);
  });

  it("falls back to the plain prompt with no evidence when buildCodeIntelligenceResult is unavailable", async () => {
    const intelligence = createIntelligence("legacy prompt only");
    const tool = createExploreCodeTool(intelligence);

    await expect(
      tool.invoke({
        request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
        input: { query: "provider" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ content: "legacy prompt only", evidence: [] });
  });

  it.each([
    ["blank query", { query: "   " }],
    ["extra fields", { query: "provider", scope: "all" }],
    ["query over 1000 UTF-16 code units", { query: "x".repeat(1001) }],
  ])("rejects %s", async (_name, input) => {
    const tool = createExploreCodeTool(createIntelligence("unused"));

    await expect(
      tool.invoke({
        request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input },
        input,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid exploreCode input");
  });

  it("returns a bounded observation when no code context matches", async () => {
    const tool = createExploreCodeTool(createIntelligence(""));

    await expect(
      tool.invoke({
        request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
        input: { query: "missing symbol" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ content: "未命中代码上下文。", evidence: [] });
  });

  it("hides internal search errors from the model observation", async () => {
    const tool = createExploreCodeTool(createIntelligence(new Error("E:\\secret\\source.ts\nprivate stack")));

    const observation = await tool.invoke({
      request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
      input: { query: "provider" },
      signal: new AbortController().signal,
    });

    expect(observation).toEqual({ content: "代码搜索失败，请调整查询后重试。", evidence: [] });
    expect(JSON.stringify(observation)).not.toContain("E:\\secret");
    expect(JSON.stringify(observation)).not.toContain("stack");
  });

  it("throws AbortError when cancelled before or during search", async () => {
    const before = new AbortController();
    before.abort();
    const beforeTool = createExploreCodeTool(createIntelligence("unused"));

    await expect(
      beforeTool.invoke({
        request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
        input: { query: "provider" },
        signal: before.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const during = new AbortController();
    const duringTool = createExploreCodeTool({
      async buildCodeIntelligencePrompt() {
        during.abort();
        return "must not be returned";
      },
    });
    await expect(
      duringTool.invoke({
        request: { id: "call-2", name: "exploreCode", rawArguments: "{}", input: {} },
        input: { query: "provider" },
        signal: during.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
