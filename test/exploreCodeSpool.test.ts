import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createExploreCodeTool } from "../src/extension/agent/exploreCodeTool";
import type { WorkspaceIntelligence } from "../src/extension/intelligence/workspaceIntelligence";
import { rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("exploreCodeTool spool functionality", () => {
  const testWorkspaceRoot = join(process.cwd(), ".test-spool-workspace");
  const conversationId = "test-conversation-123";
  const runId = "test-run-456";

  beforeEach(() => {
    // 创建测试工作区
    if (!existsSync(testWorkspaceRoot)) {
      mkdirSync(testWorkspaceRoot, { recursive: true });
    }
  });

  afterEach(() => {
    // 清理测试工作区
    if (existsSync(testWorkspaceRoot)) {
      rmSync(testWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it("should write spool file when edges are truncated", async () => {
    const mockIntelligence: WorkspaceIntelligence = {
      async buildCodeIntelligencePrompt() {
        return "## 代码语义索引上下文\n\n查询: test\n\n### 入口符号\n- function testFunc";
      },
      async buildCodeIntelligenceResult() {
        return {
          prompt: "## 代码语义索引上下文\n\n查询: test",
          snippets: [
            {
              filePath: "test.ts",
              startLine: 1,
              endLine: 5,
              text: "function testFunc() {}",
            },
          ],
          fullGraphData: {
            entryNodes: [
              { id: "node1", name: "testFunc", kind: "function", filePath: "test.ts", startLine: 1 },
            ],
            relatedNodes: [
              { id: "node2", name: "helperFunc", kind: "function", filePath: "test.ts", startLine: 10 },
            ],
            edges: [
              { source: "node1", target: "node2", kind: "calls" },
              { source: "node2", target: "node3", kind: "calls" },
            ],
            totalEdges: 50,
            previewEdges: 2,
          },
        };
      },
      getStatus() {
        return "ready";
      },
      getDiagnostics() {
        return [];
      },
    };

    const tool = createExploreCodeTool(mockIntelligence, testWorkspaceRoot);
    const result = await tool.invoke({
      request: {
        id: "req1",
        name: "exploreCode",
        rawArguments: '{"query":"test"}',
        input: { query: "test" },
      },
      input: { query: "test" },
      signal: new AbortController().signal,
      conversationId,
      runId,
    });

    expect(result.content).toContain("完整调用图已保存");
    expect(result.content).toMatch(/\.loopagent[\\/]runs[\\/]test-conversation-123[\\/]explore-/);
    expect(result.content).toContain("预览显示: 2 条边");
    expect(result.content).toContain("完整图包含: 50 条边");

    // 验证 spool 文件存在
    const spoolDir = join(testWorkspaceRoot, ".loopagent", "runs", conversationId);
    expect(existsSync(spoolDir)).toBe(true);

    // 验证 JSON 内容
    const files = require("fs").readdirSync(spoolDir);
    const spoolFile = files.find((f: string) => f.startsWith("explore-"));
    expect(spoolFile).toBeDefined();

    const spoolPath = join(spoolDir, spoolFile);
    const spoolContent = JSON.parse(readFileSync(spoolPath, "utf-8"));

    expect(spoolContent.entryNodes).toHaveLength(1);
    expect(spoolContent.relatedNodes).toHaveLength(1);
    expect(spoolContent.edges).toHaveLength(2);
    expect(spoolContent.totalEdges).toBe(50);
    expect(spoolContent.previewEdges).toBe(2);
  });

  it("should not write spool file when edges are not truncated", async () => {
    const mockIntelligence: WorkspaceIntelligence = {
      async buildCodeIntelligencePrompt() {
        return "## 代码语义索引上下文";
      },
      async buildCodeIntelligenceResult() {
        return {
          prompt: "## 代码语义索引上下文\n\n✅ **Results Status**: COMPLETE",
          snippets: [],
          // No fullGraphData means no truncation
        };
      },
      getStatus() {
        return "ready";
      },
      getDiagnostics() {
        return [];
      },
    };

    const tool = createExploreCodeTool(mockIntelligence, testWorkspaceRoot);
    const result = await tool.invoke({
      request: {
        id: "req2",
        name: "exploreCode",
        rawArguments: '{"query":"small"}',
        input: { query: "small" },
      },
      input: { query: "small" },
      signal: new AbortController().signal,
      conversationId,
      runId,
    });

    expect(result.content).not.toContain("完整调用图已保存");
    expect(result.content).toContain("✅ **Results Status**: COMPLETE");

    // 验证 spool 目录不存在或为空
    const spoolDir = join(testWorkspaceRoot, ".loopagent", "runs", conversationId);
    if (existsSync(spoolDir)) {
      const files = require("fs").readdirSync(spoolDir);
      expect(files.length).toBe(0);
    }
  });

  it("should work without workspace root (no spool)", async () => {
    const mockIntelligence: WorkspaceIntelligence = {
      async buildCodeIntelligencePrompt() {
        return "## 代码语义索引上下文";
      },
      async buildCodeIntelligenceResult() {
        return {
          prompt: "## 代码语义索引上下文",
          snippets: [],
          fullGraphData: {
            entryNodes: [],
            relatedNodes: [],
            edges: [],
            totalEdges: 10,
            previewEdges: 5,
          },
        };
      },
      getStatus() {
        return "ready";
      },
      getDiagnostics() {
        return [];
      },
    };

    // 不传递 workspaceRoot
    const tool = createExploreCodeTool(mockIntelligence);
    const result = await tool.invoke({
      request: {
        id: "req3",
        name: "exploreCode",
        rawArguments: '{"query":"no-workspace-root-query"}',
        input: { query: "no-workspace-root-query" },
      },
      input: { query: "no-workspace-root-query" },
      signal: new AbortController().signal,
      conversationId,
      runId,
    });

    // 不应包含 spool 相关内容
    expect(result.content).not.toContain("完整调用图已保存");
    expect(result.productive).toBe(true);
  });
});
