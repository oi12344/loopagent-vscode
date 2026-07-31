import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CONVERSATION_TURNS,
  evaluateConversation,
  evaluateTurn,
  measureContextCarryover,
  analyzeWorkflowEvents,
} = require("../scripts/multiTurnConversationE2e.js");

type TurnDefinition = { id: string; intent: string; prompt: string; expectsGraph: boolean };

const definitions = CONVERSATION_TURNS as TurnDefinition[];

function graphTurn(overrides: Record<string, unknown> = {}) {
  return {
    answer:
      "提交入口在 src/webview/App.tsx 的 submitTask，扩展侧由 src/extension/agentRunner.ts 的 executeRun 分流，" +
      "并发限制在 src/extension/agent/workflowOrchestrator.ts 的 schedule。",
    reasoning: "先定位提交链路，再看调度器。",
    toolCalls: [{ name: "runDynamicGraph", input: "{}", output: "{}" }],
    graphNodes: [
      { id: "a", role: "explorer", dependsOn: [] },
      { id: "b", role: "explorer", dependsOn: [] },
    ],
    workflowEvents: [
      { agentId: "a", status: "running", at: 1_000 },
      { agentId: "b", status: "running", at: 1_100 },
      { agentId: "a", status: "completed", at: 5_000 },
      { agentId: "b", status: "completed", at: 5_200 },
    ],
    elapsedMs: 42_000,
    error: "",
    ...overrides,
  };
}

function followupTurn(overrides: Record<string, unknown> = {}) {
  return {
    answer: "最小改动落在 workflowOrchestrator.ts 的 schedule，把 hasRunningExecutor 换成按文件的资源锁。",
    reasoning: "沿用上一轮结论。",
    toolCalls: [{ name: "readFile", input: "workflowOrchestrator.ts", output: "..." }],
    graphNodes: [],
    workflowEvents: [],
    elapsedMs: 20_000,
    error: "",
    ...overrides,
  };
}

function synthesisTurn(overrides: Record<string, unknown> = {}) {
  return {
    answer:
      "放开 hasRunningExecutor 之后，风险集中在 applyEdit 的保存时机，必须先补持久化测试。",
    reasoning: "综合前两轮。",
    toolCalls: [],
    graphNodes: [],
    workflowEvents: [],
    elapsedMs: 15_000,
    error: "",
    ...overrides,
  };
}

describe("multi-turn conversation e2e scenario", () => {
  it("defines three turns where only the first one opens a graph", () => {
    expect(definitions).toHaveLength(3);
    expect(definitions.filter((turn) => turn.expectsGraph)).toHaveLength(1);
    expect(definitions[0].expectsGraph).toBe(true);
  });

  it("keeps follow-up prompts free of the symbols used to prove context carryover", () => {
    // 若后续提问里直接点名 schedule/applyEdit，跨轮复现就无法证明上下文被带上。
    for (const turn of definitions.slice(1)) {
      expect(turn.prompt).not.toContain("workflowOrchestrator");
      expect(turn.prompt).not.toContain("schedule");
    }
  });
});

describe("evaluateTurn", () => {
  it("extracts cited paths, symbols and graph shape", () => {
    const report = evaluateTurn(graphTurn(), definitions[0]);

    expect(report.citedPaths).toContain("src/extension/agent/workflowOrchestrator.ts");
    expect(report.citedPaths).toContain("src/webview/App.tsx");
    expect(report.symbols).toContain("submitTask");
    expect(report.graphNodeCount).toBe(2);
    expect(report.reviewerAbsent).toBe(true);
    expect(report.maxConcurrent).toBe(2);
    expect(report.mutatingToolCalls).toEqual([]);
  });

  it("flags mutating tool calls when the prompt forbade edits", () => {
    const report = evaluateTurn(
      graphTurn({ toolCalls: [{ name: "applyEdit", input: "a.txt", output: "ok" }] }),
      definitions[0],
    );

    expect(report.mutatingToolCalls).toEqual(["applyEdit"]);
  });

  it("flags answers that still contain raw markdown markers", () => {
    const report = evaluateTurn(graphTurn({ answer: "## 结论\n未渲染" }), definitions[0]);

    expect(report.rendersRawMarkdown).toBe(true);
  });
});

describe("measureContextCarryover", () => {
  it("counts symbols reused from the previous turn but absent from the prompt", () => {
    const first = evaluateTurn(graphTurn(), definitions[0]);
    const second = evaluateTurn(followupTurn(), definitions[1]);
    const carryover = measureContextCarryover(first, second, definitions[1].prompt);

    expect(carryover?.carried).toBe(true);
    expect(carryover?.carriedSymbols).toContain("workflowOrchestrator");
  });

  it("does not credit symbols that the prompt itself supplied", () => {
    const first = evaluateTurn(graphTurn(), definitions[0]);
    const second = evaluateTurn(followupTurn({ answer: "见 submitTask" }), definitions[1]);
    const carryover = measureContextCarryover(first, second, "请解释 submitTask");

    expect(carryover?.carriedSymbols).not.toContain("submitTask");
    expect(carryover?.carried).toBe(false);
  });

  it("returns null for the first turn", () => {
    expect(measureContextCarryover(undefined, evaluateTurn(graphTurn(), definitions[0]), "x")).toBeNull();
  });
});

describe("evaluateConversation", () => {
  it("passes when all turns answer, stay read-only and carry context", () => {
    const evaluation = evaluateConversation([graphTurn(), followupTurn(), synthesisTurn()]);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.completedAllTurns).toBe(true);
    expect(evaluation.respectedReadOnly).toBe(true);
    expect(evaluation.contextRetained).toBe(true);
    expect(evaluation.graphParallelism).toBe(2);
    expect(evaluation.turns).toHaveLength(3);
  });

  it("fails when a later turn drops the earlier context", () => {
    const evaluation = evaluateConversation([
      graphTurn(),
      followupTurn({ answer: "建议重写整个调度层。" }),
      synthesisTurn(),
    ]);

    expect(evaluation.contextRetained).toBe(false);
    expect(evaluation.passed).toBe(false);
  });

  it("fails when the conversation stops early", () => {
    const evaluation = evaluateConversation([graphTurn(), followupTurn({ error: "boom" })]);

    expect(evaluation.completedAllTurns).toBe(false);
    expect(evaluation.passed).toBe(false);
  });

  it("fails when an edit tool ran despite the read-only instruction", () => {
    const evaluation = evaluateConversation([
      graphTurn(),
      followupTurn({ toolCalls: [{ name: "applyEdit", input: "x", output: "ok" }] }),
      synthesisTurn(),
    ]);

    expect(evaluation.respectedReadOnly).toBe(false);
    expect(evaluation.passed).toBe(false);
  });
});

describe("analyzeWorkflowEvents", () => {
  it("reports serial execution as concurrency one", () => {
    const { maxConcurrent, completedNodes } = analyzeWorkflowEvents([
      { agentId: "a", status: "running", at: 1_000 },
      { agentId: "a", status: "completed", at: 2_000 },
      { agentId: "b", status: "running", at: 2_100 },
      { agentId: "b", status: "completed", at: 3_000 },
    ]);

    expect(maxConcurrent).toBe(1);
    expect(completedNodes).toBe(2);
  });

  it("excludes failed nodes from the completed count", () => {
    const { completedNodes, failedNodes } = analyzeWorkflowEvents([
      { agentId: "a", status: "running", at: 1_000 },
      { agentId: "a", status: "failed", at: 2_000 },
    ]);

    expect(completedNodes).toBe(0);
    expect(failedNodes).toBe(1);
  });
});
