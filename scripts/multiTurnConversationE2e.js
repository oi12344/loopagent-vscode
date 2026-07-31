// 多轮复杂对话 E2E 的场景定义与评估逻辑。
// 与 CDP 驱动脚本分离，便于用 vitest 单独回归判分规则。

// 三轮对话刻意设计成后一轮依赖前一轮的结论，且后续轮次不重复陈述实体名，
// 以便用「跨轮符号复现」来判断上下文是否真的被带上。
const CONVERSATION_TURNS = [
  {
    id: "turn-1-architecture",
    intent: "触发动态运行图，做两条调用链的并行只读分析",
    expectsGraph: true,
    prompt:
      "请只用一张运行图，创建两个无依赖、可并行的只读分析节点，每个节点聚焦一条调用链，不要创建 reviewer，不要修改任何代码，每个节点使用 60 秒超时。" +
      "问题：（1）Webview 提交一次请求后，扩展侧如何决定走普通单智能体还是动态工作流；（2）动态工作流的节点并发是如何被限制的。" +
      "请给出关键文件与函数级证据。",
  },
  {
    id: "turn-2-followup",
    intent: "承接上一轮的并发结论，定位最小改动点（考察上下文保持）",
    expectsGraph: false,
    prompt:
      "基于你上面给出的并发限制结论，如果我想让两个只写不同文件的执行节点真正并行，最小改动应该落在你刚才提到的哪个函数里？" +
      "请只做分析，不要修改代码，也不要再开运行图。",
  },
  {
    id: "turn-3-synthesis",
    intent: "跨两轮综合推理，输出风险与必须补的测试",
    expectsGraph: false,
    prompt:
      "把前面两轮的结论合起来：这个最小改动会引入哪些正确性风险？请特别说明与文件保存时机相关的风险，并给出你认为必须先补的测试。仍然不要修改代码。",
  },
];

const SYMBOL_PATTERN = /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const PATH_PATTERN =
  /src\/(?:extension\.ts|webview\/[A-Za-z0-9_./-]+\.tsx?|extension\/[A-Za-z0-9_./-]+\.ts|shared\/[A-Za-z0-9_./-]+\.ts)(?![A-Za-z0-9_])/g;
// 渲染后的正文里不应该再看到原始 Markdown 标记，否则说明 AssistantAnswer 没解析。
const RAW_MARKDOWN_PATTERN = /(^|\n)\s*(#{2,}\s|\|[^\n]*\|\s*$|```)/;
// 三轮都明确要求不改代码，出现写工具即视为越界。
const MUTATING_TOOLS = ["applyEdit", "writeFile", "createFile", "deleteFile", "runCommand"];

function extractSymbols(text) {
  return new Set(text.match(SYMBOL_PATTERN) ?? []);
}

function extractPaths(text) {
  return new Set((text.replaceAll("\\", "/").match(PATH_PATTERN) ?? []));
}

function evaluateTurn(turn, definition) {
  const answer = turn.answer ?? "";
  const toolNames = (turn.toolCalls ?? []).map((call) => call.name);
  const graphNodes = Array.isArray(turn.graphNodes) ? turn.graphNodes : [];
  const { maxConcurrent, completedNodes, failedNodes } = analyzeWorkflowEvents(
    turn.workflowEvents ?? [],
  );

  return {
    id: definition.id,
    intent: definition.intent,
    answerLength: answer.length,
    reasoningLength: (turn.reasoning ?? "").length,
    elapsedMs: turn.elapsedMs ?? null,
    toolCalls: toolNames,
    mutatingToolCalls: toolNames.filter((name) => MUTATING_TOOLS.includes(name)),
    graphNodeCount: graphNodes.length,
    graphRoles: graphNodes.map((node) => node.role),
    reviewerAbsent: graphNodes.every((node) => node.role !== "reviewer"),
    maxConcurrent,
    completedNodes,
    failedNodes,
    citedPaths: [...extractPaths(answer)],
    symbols: [...extractSymbols(answer)],
    rendersRawMarkdown: RAW_MARKDOWN_PATTERN.test(answer),
    errored: Boolean(turn.error),
    error: turn.error ?? "",
  };
}

// 后续轮次的提问没有点名任何符号，因此答案里复现的上一轮符号只能来自对话上下文。
function measureContextCarryover(previousReport, currentReport, currentPrompt) {
  if (!previousReport) return null;

  const previous = new Set(previousReport.symbols);
  const previousPaths = new Set(previousReport.citedPaths);
  const carriedSymbols = currentReport.symbols.filter(
    (symbol) => previous.has(symbol) && !currentPrompt.includes(symbol),
  );
  const carriedPaths = currentReport.citedPaths.filter(
    (path) => previousPaths.has(path) && !currentPrompt.includes(path),
  );

  return {
    from: previousReport.id,
    carriedSymbols,
    carriedPaths,
    carried: carriedSymbols.length > 0 || carriedPaths.length > 0,
  };
}

function evaluateConversation(turns, definitions = CONVERSATION_TURNS) {
  const reports = [];
  const carryover = [];

  definitions.forEach((definition, index) => {
    const turn = turns[index];
    if (!turn) return;
    const report = evaluateTurn(turn, definition);
    const measured = measureContextCarryover(reports.at(-1), report, definition.prompt);
    if (measured) carryover.push({ at: report.id, ...measured });
    reports.push(report);
  });

  const completedAllTurns = reports.length === definitions.length &&
    reports.every((report) => !report.errored && report.answerLength > 0);
  const graphTurn = reports.find(
    (report) => definitions.find((item) => item.id === report.id)?.expectsGraph,
  );
  const respectedReadOnly = reports.every((report) => report.mutatingToolCalls.length === 0);
  const contextRetained = carryover.length > 0 && carryover.every((entry) => entry.carried);

  return {
    passed:
      completedAllTurns &&
      respectedReadOnly &&
      contextRetained &&
      Boolean(graphTurn && graphTurn.graphNodeCount >= 2 && graphTurn.reviewerAbsent),
    completedAllTurns,
    respectedReadOnly,
    contextRetained,
    graphParallelism: graphTurn?.maxConcurrent ?? 0,
    turns: reports,
    carryover,
  };
}

function analyzeWorkflowEvents(events) {
  const intervals = new Map();
  for (const event of [...events].sort((left, right) => left.at - right.at)) {
    const interval = intervals.get(event.agentId) ?? {};
    if (event.status === "running" && interval.startedAt === undefined) {
      interval.startedAt = event.at;
    }
    if (["completed", "failed", "cancelled"].includes(event.status)) {
      interval.finishedAt = event.at;
      interval.status = event.status;
    }
    intervals.set(event.agentId, interval);
  }

  const all = [...intervals.values()];
  const completed = all.filter(
    (interval) =>
      interval.status === "completed" &&
      interval.startedAt !== undefined &&
      interval.finishedAt >= interval.startedAt,
  );
  const points = completed
    .flatMap((interval) => [
      { at: interval.startedAt, delta: 1 },
      { at: interval.finishedAt, delta: -1 },
    ])
    .sort((left, right) => left.at - right.at || right.delta - left.delta);

  let concurrent = 0;
  let maxConcurrent = 0;
  for (const point of points) {
    concurrent += point.delta;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
  }

  return {
    maxConcurrent,
    completedNodes: completed.length,
    failedNodes: all.filter((interval) => interval.status === "failed").length,
  };
}

module.exports = {
  CONVERSATION_TURNS,
  evaluateConversation,
  evaluateTurn,
  measureContextCarryover,
  analyzeWorkflowEvents,
};
