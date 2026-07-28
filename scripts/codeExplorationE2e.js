const CODE_EXPLORATION_QUESTION =
  "请在不修改代码的前提下，第一张且唯一一张运行图就恰好创建两个无依赖、可并行的只读分析节点，每个只聚焦一条调用链；运行图完成后由父智能体直接核对并汇总两个节点的结果，不要创建 reviewer。不要先做目录结构探索，不要枚举整个仓库或逐文件读取，每个节点使用 60 秒超时。问题：本项目从 Webview 提交请求到 DeepSeek 创建并执行运行时工作流，关键调用链和角色权限边界是什么？请给出关键源码文件和函数证据，并指出并发与串行约束。";

const REQUIRED_STATES = [
  "runDynamicGraph",
  "Done",
];
const ANCHOR_GROUPS = [
  ["submitTask"],
  ["executeRun", "startAgentRun"],
  ["createConfiguredAgentRunner", "systemPromptProvider", "collectVsCodeRuntimeContext"],
  ["createDynamicWorkflowTools", "createDynamicGraphEngine"],
  ["createWorkflowOrchestrator", "resolveRole"],
  ["collectCodeRuntimeContext"],
  ["renderCodeRuntimeContextPrompt"],
  ["createExploreCodeTool", "buildCodeIntelligencePrompt", "renderCodeIntelligencePrompt"],
  ["createOpenAiReactModelTurn"],
];
const PATH_PATTERN =
  /src\/(?:extension\.ts|webview\/App\.tsx|extension\/[A-Za-z0-9_./-]+\.ts)(?![A-Za-z0-9_])/g;
const REQUIRED_INTELLIGENCE_PATHS = new Set([
  "src/webview/App.tsx",
  "src/extension.ts",
  "src/extension/agentRunner.ts",
  "src/extension/model/providerRegistry.ts",
  "src/extension/agent/dynamicWorkflowTools.ts",
  "src/extension/agent/workflow/dynamicGraphEngine.ts",
  "src/extension/agent/workflowOrchestrator.ts",
  "src/extension/agent/workflow/roleRegistry.ts",
  "src/extension/agent/exploreCodeTool.ts",
  "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
  "src/extension/runtime/vscodeRuntimeContext.ts",
  "src/extension/runtime/codeRuntimeContext.ts",
  "src/extension/runtime/contextPrompt.ts",
  "src/extension/intelligence/context/codeIntelligencePrompt.ts",
]);

function evaluateCodeExploration({ process, answer, workflowEvents = [], graphNodes = [] }) {
  const missingStates = REQUIRED_STATES.filter((state) => !process.includes(state));
  const toolCalls = ["runDynamicGraph"].filter((name) => process.includes(name));
  const matchedAnchors = ANCHOR_GROUPS.flatMap((group) => {
    const matched = group.find((anchor) => answer.includes(anchor));
    return matched ? [matched] : [];
  });
  const normalizedAnswer = answer.replaceAll("\\", "/");
  const matchedPaths = [...new Set(normalizedAnswer.match(PATH_PATTERN) ?? [])];
  const hasRequiredIntelligencePath = matchedPaths.some((path) =>
    REQUIRED_INTELLIGENCE_PATHS.has(path),
  );
  const reviewerAbsent =
    Array.isArray(graphNodes) &&
    graphNodes.length > 0 &&
    graphNodes.every((node) => node.role !== "reviewer");
  const graphStructureValid = hasRequiredGraphStructure(graphNodes);
  const { maxConcurrent } = analyzeWorkflowEvents(workflowEvents);
  const parallelReadOnlyNodes = graphStructureValid ? maxConcurrent : 0;

  return {
    passed:
      missingStates.length === 0 &&
      matchedAnchors.length >= 3 &&
      matchedPaths.length >= 2 &&
      hasRequiredIntelligencePath &&
      parallelReadOnlyNodes >= 2 &&
      reviewerAbsent,
    matchedAnchors,
    matchedPaths,
    missingStates,
    toolCalls,
    parallelReadOnlyNodes,
    reviewerAbsent,
  };
}

function hasRequiredGraphStructure(nodes) {
  return Array.isArray(nodes) &&
    nodes.length === 2 &&
    nodes.every(
      (node) =>
        ["explorer", "planner"].includes(node.role) &&
        (node.dependsOn ?? []).length === 0,
  );
}

function analyzeWorkflowEvents(events) {
  const intervals = new Map();
  for (const event of [...events].sort((left, right) => left.at - right.at)) {
    const interval = intervals.get(event.agentId) ?? {};
    if (event.status === "running" && interval.startedAt === undefined) interval.startedAt = event.at;
    if (["completed", "failed", "cancelled"].includes(event.status)) {
      interval.finishedAt = event.at;
      interval.status = event.status;
    }
    intervals.set(event.agentId, interval);
  }

  const completed = [...intervals.values()].filter(
    (interval) => interval.status === "completed" && interval.startedAt !== undefined && interval.finishedAt >= interval.startedAt,
  );
  const points = completed.flatMap((interval) => [
    { at: interval.startedAt, delta: 1 },
    { at: interval.finishedAt, delta: -1 },
  ]).sort((left, right) => left.at - right.at || right.delta - left.delta);
  let concurrent = 0;
  let maxConcurrent = 0;
  for (const point of points) {
    concurrent += point.delta;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
  }
  return { maxConcurrent };
}

module.exports = { CODE_EXPLORATION_QUESTION, evaluateCodeExploration };
