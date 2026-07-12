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
    ).resolves.toBe("provider registry context");
    expect(intelligence.buildCodeIntelligencePrompt).toHaveBeenCalledWith("provider registry");
    expect(tool).toMatchObject({
      name: "exploreCode",
      inputSchema: expect.objectContaining({ additionalProperties: false }),
    });
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
    ).resolves.toBe("未命中代码上下文。");
  });

  it("hides internal search errors from the model observation", async () => {
    const tool = createExploreCodeTool(createIntelligence(new Error("E:\\secret\\source.ts\nprivate stack")));

    const observation = await tool.invoke({
      request: { id: "call-1", name: "exploreCode", rawArguments: "{}", input: {} },
      input: { query: "provider" },
      signal: new AbortController().signal,
    });

    expect(observation).toBe("代码搜索失败，请调整查询后重试。");
    expect(observation).not.toContain("E:\\secret");
    expect(observation).not.toContain("stack");
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
