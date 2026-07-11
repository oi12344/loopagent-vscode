const CODE_EXPLORATION_QUESTION =
  "追踪 LoopAgentChatViewProvider.startRun 到生成代码语义上下文的调用链，并说明工作区源码缓存何时失效。请列出关键源码文件和函数。";

const REQUIRED_STATES = [
  "Building code context",
  "Calling DeepSeek deepseek-v4-flash",
  "Done",
];
const ANCHORS = [
  "createConfiguredAgentRunner",
  "systemPromptProvider",
  "buildCodeIntelligencePrompt",
  "createVsCodeWorkspaceIntelligence",
  "sourceCache",
  "dirtyPaths",
  "watcher",
];
const PATH_PATTERN = /src\/(?:extension\.ts|extension\/[A-Za-z0-9_./-]+\.ts)/g;
const REQUIRED_INTELLIGENCE_PATHS = new Set([
  "src/extension/model/providerRegistry.ts",
  "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
]);

function evaluateCodeExploration({ process, answer }) {
  const missingStates = REQUIRED_STATES.filter((state) => !process.includes(state));
  const matchedAnchors = ANCHORS.filter((anchor) => answer.includes(anchor));
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
