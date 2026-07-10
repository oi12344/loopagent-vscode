export type CodeIntelligenceContextMode = "graph-summary" | "focused-source" | "expanded-source";

export type CodeIntelligenceBudgetProfile = {
  mode: CodeIntelligenceContextMode;
  reason: string;
  maxEntryNodes: number;
  expandDepth: number;
  maxRelatedNodes: number;
  maxEdges: number;
  maxSnippetNodes: number;
  maxSnippetChars: number;
  maxSnippetLines: number;
};

export function evaluateCodeIntelligenceBudget(query: string, maxPromptChars: number): CodeIntelligenceBudgetProfile {
  const normalized = query.toLowerCase();

  if (matchesAny(normalized, CHANGE_QUERY_MARKERS)) {
    return createProfile({
      mode: "expanded-source",
      reason: "code-change-or-debug-query",
      maxPromptChars,
      maxEntryNodes: 8,
      expandDepth: 1,
      maxRelatedNodes: 14,
      maxEdges: 32,
      maxSnippetNodes: 6,
      maxSnippetChars: 6_000,
      maxSnippetLines: 120,
    });
  }

  if (matchesAny(normalized, GRAPH_QUERY_MARKERS)) {
    return createProfile({
      mode: "graph-summary",
      reason: "architecture-or-relationship-query",
      maxPromptChars,
      maxEntryNodes: 6,
      expandDepth: 1,
      maxRelatedNodes: 10,
      maxEdges: 24,
      maxSnippetNodes: 0,
      maxSnippetChars: 0,
      maxSnippetLines: 0,
    });
  }

  return createProfile({
    mode: "focused-source",
    reason: matchesAny(normalized, EXPLANATION_QUERY_MARKERS) ? "implementation-explanation-query" : "default-focused-query",
    maxPromptChars,
    maxEntryNodes: 5,
    expandDepth: 2,
    maxRelatedNodes: 14,
    maxEdges: 28,
    maxSnippetNodes: 5,
    maxSnippetChars: 6_000,
    maxSnippetLines: 90,
  });
}

type ProfileInput = Omit<CodeIntelligenceBudgetProfile, "maxSnippetChars"> & {
  maxPromptChars: number;
  maxSnippetChars: number;
};

function createProfile(input: ProfileInput): CodeIntelligenceBudgetProfile {
  return {
    mode: input.mode,
    reason: input.reason,
    maxEntryNodes: input.maxEntryNodes,
    expandDepth: input.expandDepth,
    maxRelatedNodes: input.maxRelatedNodes,
    maxEdges: input.maxEdges,
    maxSnippetNodes: input.maxSnippetNodes,
    maxSnippetChars: Math.min(input.maxPromptChars, input.maxSnippetChars),
    maxSnippetLines: input.maxSnippetLines,
  };
}

function matchesAny(value: string, markers: RegExp[]): boolean {
  return markers.some((marker) => marker.test(value));
}

const GRAPH_QUERY_MARKERS = [
  /\barch(?:itecture)?\b/,
  /\bcall\s*graph\b/,
  /\bcall\s*chain\b/,
  /\bdependenc(?:y|ies)\b/,
  /\bimpact\b/,
  /\brelationship\b/,
  /\bstructure\b/,
  /架构/,
  /调用链/,
  /调用图/,
  /依赖/,
  /影响/,
  /关系/,
  /结构/,
];

const CHANGE_QUERY_MARKERS = [
  /\bfix\b/,
  /\bbug\b/,
  /\bdebug\b/,
  /\berror\b/,
  /\bfail(?:ure|ing|ed)?\b/,
  /\bmodify\b/,
  /\bchange\b/,
  /\bupdate\b/,
  /\bimplement\b/,
  /\brefactor\b/,
  /\btest\b/,
  /修复/,
  /修改/,
  /改造/,
  /实现/,
  /报错/,
  /错误/,
  /失败/,
  /调试/,
  /优化代码/,
];

const EXPLANATION_QUERY_MARKERS = [
  /\bexplain\b/,
  /\bhow\b/,
  /\bwhy\b/,
  /\bflow\b/,
  /\bparse\b/,
  /解释/,
  /说明/,
  /如何/,
  /怎么/,
  /流程/,
  /解析/,
];
