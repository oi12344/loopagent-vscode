const CODE_EXPLORATION_QUESTION =
  "谁负责把代码上下文加入模型请求？请列出关键源码文件和函数。";

const REQUIRED_STATES = [
  "Planning step 1",
  "Running tool exploreCode",
  "Planning step 2",
  "Done",
];
const ANCHOR_GROUPS = [
  ["createConfiguredAgentRunner", "systemPromptProvider", "collectVsCodeRuntimeContext"],
  ["collectCodeRuntimeContext"],
  ["renderCodeRuntimeContextPrompt"],
  ["createExploreCodeTool", "buildCodeIntelligencePrompt", "renderCodeIntelligencePrompt"],
  ["createOpenAiReactModelTurn"],
];
const PATH_PATTERN =
  /src\/(?:extension\.ts|extension\/[A-Za-z0-9_./-]+\.ts)(?![A-Za-z0-9_])/g;
const REQUIRED_INTELLIGENCE_PATHS = new Set([
  "src/extension/model/providerRegistry.ts",
  "src/extension/agent/exploreCodeTool.ts",
  "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
  "src/extension/runtime/vscodeRuntimeContext.ts",
  "src/extension/runtime/codeRuntimeContext.ts",
  "src/extension/runtime/contextPrompt.ts",
  "src/extension/intelligence/context/codeIntelligencePrompt.ts",
]);

function evaluateCodeExploration({ process, answer }) {
  const missingStates = REQUIRED_STATES.filter((state) => !process.includes(state));
  const matchedAnchors = ANCHOR_GROUPS.flatMap((group) => {
    const matched = group.find((anchor) => answer.includes(anchor));
    return matched ? [matched] : [];
  });
  const normalizedAnswer = answer.replaceAll("\\", "/");
  const matchedPaths = [...new Set(normalizedAnswer.match(PATH_PATTERN) ?? [])];
  const hasRequiredIntelligencePath = matchedPaths.some((path) =>
    REQUIRED_INTELLIGENCE_PATHS.has(path),
  );

  return {
    passed:
      missingStates.length === 0 &&
      matchedAnchors.length >= 3 &&
      matchedPaths.length >= 2 &&
      hasRequiredIntelligencePath,
    matchedAnchors,
    matchedPaths,
    missingStates,
  };
}

module.exports = { CODE_EXPLORATION_QUESTION, evaluateCodeExploration };
