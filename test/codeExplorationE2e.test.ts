import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { CODE_EXPLORATION_QUESTION, evaluateCodeExploration } = require(
  "../scripts/codeExplorationE2e.js",
) as {
  CODE_EXPLORATION_QUESTION: string;
  evaluateCodeExploration(result: { process: string; answer: string; workflowEvents?: WorkflowEvent[]; graphNodes?: GraphNode[] }): {
    passed: boolean;
    matchedAnchors: string[];
    matchedPaths: string[];
    missingStates: string[];
    toolCalls: string[];
    parallelReadOnlyNodes: number;
    reviewerCompleted: boolean;
  };
};

type WorkflowEvent = { agentId: string; status: string; at: number };
type GraphNode = { id: string; role?: string; dependsOn?: string[] };

const expectedQuestion =
  "请在不修改代码的前提下，第一张且唯一一张运行图就恰好创建三个节点：两个无依赖、可并行的只读分析节点，每个只聚焦一条调用链；第三个审查节点同时依赖前两个节点并统一核对。不要先做目录结构探索，不要枚举整个仓库或逐文件读取，每个节点使用 60 秒超时。问题：本项目从 Webview 提交请求到 DeepSeek 创建并执行运行时工作流，关键调用链和角色权限边界是什么？请给出关键源码文件和函数证据，并指出并发与串行约束。";

const completeProcess = "runDynamicGraph\nreviewer\nDone";
const completedWorkflow: WorkflowEvent[] = [
  { agentId: "subagent-1", status: "running", at: 1 },
  { agentId: "subagent-2", status: "running", at: 2 },
  { agentId: "subagent-1", status: "completed", at: 5 },
  { agentId: "subagent-2", status: "completed", at: 6 },
  { agentId: "subagent-3", status: "running", at: 7 },
  { agentId: "subagent-3", status: "completed", at: 9 },
];
const validGraphNodes: GraphNode[] = [
  { id: "webview", role: "explorer", dependsOn: [] },
  { id: "runtime", role: "planner", dependsOn: [] },
  { id: "review", role: "reviewer", dependsOn: ["webview", "runtime"] },
];

describe("code exploration E2E oracle", () => {
  it("asks a complex project question without leaking implementation symbols", () => {
    expect(CODE_EXPLORATION_QUESTION).toBe(expectedQuestion);
    expect(CODE_EXPLORATION_QUESTION).not.toContain("createConfiguredAgentRunner");
    expect(CODE_EXPLORATION_QUESTION).not.toContain("runDynamicGraph");
  });

  it("accepts graph controls, parallel readers, a dependent reviewer, and source evidence", () => {
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: completedWorkflow,
      graphNodes: validGraphNodes,
      answer: [
        "`src/webview/App.tsx` uses submitTask.",
        "`src/extension.ts` calls executeRun and startAgentRun.",
        "`src/extension/model/providerRegistry.ts` uses createConfiguredAgentRunner.",
        "`src/extension/agent/dynamicWorkflowTools.ts` creates createDynamicGraphEngine.",
      ].join("\n"),
    });

    expect(result).toEqual({
      passed: true,
      matchedAnchors: [
        "submitTask",
        "executeRun",
        "createConfiguredAgentRunner",
        "createDynamicGraphEngine",
      ],
      matchedPaths: [
        "src/webview/App.tsx",
        "src/extension.ts",
        "src/extension/model/providerRegistry.ts",
        "src/extension/agent/dynamicWorkflowTools.ts",
      ],
      missingStates: [],
      toolCalls: ["runDynamicGraph"],
      parallelReadOnlyNodes: 2,
      reviewerCompleted: true,
    });
  });

  it("rejects a Done-only generic answer", () => {
    const result = evaluateCodeExploration({
      process: "Done",
      answer: "The extension builds context and uses the configured model.",
    });

    expect(result.passed).toBe(false);
    expect(result.matchedAnchors).toEqual([]);
    expect(result.matchedPaths).toEqual([]);
    expect(result.missingStates).toEqual(["runDynamicGraph"]);
  });

  it("rejects an otherwise semantic answer with only one source path", () => {
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: completedWorkflow,
      answer:
        "src/extension/runtime/vscodeRuntimeContext.ts links collectVsCodeRuntimeContext, collectCodeRuntimeContext, and renderCodeRuntimeContextPrompt.",
    });

    expect(result.passed).toBe(false);
    expect(result.matchedAnchors).toHaveLength(3);
    expect(result.matchedPaths).toEqual([
      "src/extension/runtime/vscodeRuntimeContext.ts",
    ]);
  });

  it("rejects two paths when neither is a required intelligence implementation", () => {
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: completedWorkflow,
      graphNodes: validGraphNodes,
      answer: [
        "src/extension/commands.ts calls collectVsCodeRuntimeContext.",
        "src/extension/chat/LoopAgentChatViewProvider.ts mentions collectCodeRuntimeContext and renderCodeRuntimeContextPrompt.",
      ].join("\n"),
    });

    expect(result.passed).toBe(false);
    expect(result.matchedPaths).toHaveLength(2);
  });

  it("normalizes markdown backslashes and deduplicates anchors and paths", () => {
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: completedWorkflow,
      graphNodes: validGraphNodes,
      answer: [
        "`src\\extension\\runtime\\vscodeRuntimeContext.ts`,, uses collectVsCodeRuntimeContext and collectCodeRuntimeContext.",
        "src/extension/runtime/vscodeRuntimeContext.ts... collectCodeRuntimeContext.",
        "**src\\extension\\runtime\\contextPrompt.ts** connects renderCodeRuntimeContextPrompt.",
      ].join("\n"),
    });

    expect(result.passed).toBe(true);
    expect(result.matchedAnchors).toEqual([
      "collectVsCodeRuntimeContext",
      "collectCodeRuntimeContext",
      "renderCodeRuntimeContextPrompt",
    ]);
    expect(result.matchedPaths).toEqual([
      "src/extension/runtime/vscodeRuntimeContext.ts",
      "src/extension/runtime/contextPrompt.ts",
    ]);
  });

  it("deduplicates tool anchors and rejects a tsx path prefix", () => {
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: completedWorkflow,
      answer: [
        "src/extension/model/providerRegistry.ts",
        "src/extension/not-real.tsx",
        "collectVsCodeRuntimeContext collectVsCodeRuntimeContext",
      ].join("\n"),
    });

    expect(result.passed).toBe(false);
    expect(result.matchedAnchors).toEqual(["collectVsCodeRuntimeContext"]);
    expect(result.matchedPaths).toEqual([
      "src/extension/model/providerRegistry.ts",
    ]);
  });

  it("rejects graph execution without overlapping readers", () => {
    const serialEvents: WorkflowEvent[] = [
      { agentId: "subagent-1", status: "running", at: 1 },
      { agentId: "subagent-1", status: "completed", at: 2 },
      { agentId: "subagent-2", status: "running", at: 3 },
      { agentId: "subagent-2", status: "completed", at: 4 },
      { agentId: "subagent-3", status: "running", at: 5 },
      { agentId: "subagent-3", status: "completed", at: 6 },
    ];

    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: serialEvents,
      graphNodes: validGraphNodes,
      answer: "src/extension/model/providerRegistry.ts createConfiguredAgentRunner src/extension/agent/dynamicWorkflowTools.ts createDynamicGraphEngine src/extension.ts executeRun",
    });

    expect(result.passed).toBe(false);
    expect(result.parallelReadOnlyNodes).toBe(1);
  });

  it("rejects a graph when any observed node fails", () => {
    const failedEvents = completedWorkflow.map((event) =>
      event.agentId === "subagent-1" && event.status === "completed"
        ? { ...event, status: "failed" }
        : event,
    );
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: failedEvents,
      graphNodes: validGraphNodes,
      answer: "src/extension/model/providerRegistry.ts createConfiguredAgentRunner src/extension/agent/dynamicWorkflowTools.ts createDynamicGraphEngine src/extension.ts executeRun",
    });

    expect(result.passed).toBe(false);
    expect(result.parallelReadOnlyNodes).toBeLessThan(2);
  });

  it("rejects concurrent executor nodes and a reviewer without both dependencies", () => {
    const result = evaluateCodeExploration({
      process: completeProcess,
      workflowEvents: completedWorkflow,
      graphNodes: [
        { id: "write-a", role: "executor", dependsOn: [] },
        { id: "write-b", role: "executor", dependsOn: [] },
        { id: "review", role: "reviewer", dependsOn: ["write-a"] },
      ],
      answer: "src/extension/model/providerRegistry.ts createConfiguredAgentRunner src/extension/agent/dynamicWorkflowTools.ts createDynamicGraphEngine src/extension.ts executeRun",
    });

    expect(result.passed).toBe(false);
    expect(result.parallelReadOnlyNodes).toBe(0);
    expect(result.reviewerCompleted).toBe(false);
  });
});

describe("code exploration CDP runner contract", () => {
  const readRunner = () =>
    readFileSync(
      resolve(process.cwd(), "scripts/run-code-exploration-e2e.mjs"),
      "utf8",
    );

  it("does not read or print the DeepSeek secret", () => {
    const runner = readRunner();
    expect(runner).not.toContain("DEEPSEEK_API_KEY");
    expect(runner).not.toContain("Authorization");
  });

  it("pins the isolated CDP endpoint, timeout, screenshot, and activity entry", () => {
    const runner = readRunner();
    expect(runner).toContain("const CDP_PORT = 9333");
    expect(runner).toContain("const WAIT_TIMEOUT_MS = 300_000");
    expect(runner).toContain("code-exploration-e2e.png");
    expect(runner).toContain('getAttribute("aria-label") === "LoopAgent"');
    expect(runner).toContain('getAttribute("aria-selected") !== "true"');
    expect(runner).toContain("activityEntry.click()");
    expect(runner).toContain("workbench.html");
    expect(runner).toContain("vscode-webview");
  });

  it("uses the real Webview composer and assistant result selectors", () => {
    const runner = readRunner();
    expect(runner).toContain('getElementById("active-frame")');
    expect(runner).toContain("contentDocument ?? document");
    expect(runner).toContain("webviewDocument.defaultView");
    expect(runner).toContain("DeepSeek v4 Flash");
    expect(runner).toContain("#message-input");
    expect(runner).toContain('form.chat-composer button[type="submit"]');
    expect(runner).toContain("HTMLTextAreaElement.prototype");
    expect(runner).toContain(".message-assistant");
    expect(runner).toContain(".tool-call-name");
    expect(runner).toContain(".tool-call-input");
    expect(runner).toContain(".workflow-timeline span");
    expect(runner).toContain("MutationObserver");
    expect(runner).toContain("workflowEvents");
    expect(runner).toContain(".assistant-answer");
    expect(runner).toContain('[role="alert"]');
  });

  it("keeps expected answer anchors out of the runner", () => {
    const runner = readRunner();
    expect(runner).not.toContain("createConfiguredAgentRunner");
    expect(runner).not.toContain("buildCodeIntelligencePrompt");
  });

  it("waits for an assistant turn created by the current submission", () => {
    const runner = readRunner();
    expect(runner).toContain("assistantTurnCount");
    expect(runner).toContain('turns.length <= ${previousTurnCount}');
  });

  it("prefers a LoopAgent target over a generic VS Code Webview", () => {
    const runner = readRunner();
    expect(runner).toContain('identity.includes("loopagent") ? 0 : 1');
  });
});
