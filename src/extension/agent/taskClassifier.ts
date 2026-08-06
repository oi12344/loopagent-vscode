/**
 * 基于规则的任务复杂度分类器
 * 用于指导主代理选择合适的执行策略：直接工具调用 vs 子代理编排
 */

export type TaskComplexity = "simple" | "medium" | "complex";

export type TaskClassification = {
  complexity: TaskComplexity;
  confidence: "high" | "low";
  reasoning: string;
};

/**
 * 分类用户任务的复杂度
 *
 * @param userQuery 用户输入的任务描述
 * @returns 分类结果（复杂度 + 置信度 + 推理过程）
 */
export function classifyTask(userQuery: string): TaskClassification {
  const query = userQuery.toLowerCase().trim();

  // 简单任务特征：单次查询、只读操作
  const simplePatterns = [
    { pattern: /^(读|查看|显示|列出|打开)/, reason: "只读操作" },
    { pattern: /在.{1,20}(文件|目录).{0,10}第.{0,5}行/, reason: "精确定位" },
    { pattern: /(什么是|如何.*工作|为什么)/, reason: "概念问题" },
    { pattern: /^(找|搜索|定位).{1,30}(函数|类|变量|方法|接口)/, reason: "符号查找" },
    { pattern: /这段代码.*做什么|这个函数.*作用/, reason: "代码理解" },
  ];

  // 复杂任务特征：多文件、架构级变更
  const complexPatterns = [
    { pattern: /(添加|新增|实现).{1,20}(功能|特性|模块)/, reason: "新功能开发" },
    { pattern: /(重构|优化|改进|升级).{1,30}(系统|架构|模块)/, reason: "架构级变更" },
    { pattern: /(修复|解决).{0,20}(所有|全部|多个)/, reason: "批量修复" },
    { pattern: /(集成|连接|对接|迁移)/, reason: "系统集成" },
    { pattern: /(所有|全部|整个|每个).{0,10}(文件|组件|模块)/, reason: "全局范围" },
    { pattern: /添加.{0,20}(深色|主题|国际化|权限)/, reason: "横切关注点" },
  ];

  // 多目标检测
  const hasMultipleGoals =
    /[和且并]/.test(query) ||
    query.split(/[，。；、]/).filter(s => s.trim().length > 0).length > 2;

  // 1. 检查简单任务
  for (const { pattern, reason } of simplePatterns) {
    if (pattern.test(query)) {
      return {
        complexity: "simple",
        confidence: "high",
        reasoning: reason,
      };
    }
  }

  // 2. 检查复杂任务
  for (const { pattern, reason } of complexPatterns) {
    if (pattern.test(query)) {
      return {
        complexity: "complex",
        confidence: "high",
        reasoning: reason,
      };
    }
  }

  // 3. 多目标任务通常是复杂的
  if (hasMultipleGoals) {
    return {
      complexity: "complex",
      confidence: "high",
      reasoning: "包含多个独立目标",
    };
  }

  // 4. 默认为中等复杂度（低置信度）
  return {
    complexity: "medium",
    confidence: "low",
    reasoning: "未匹配已知模式",
  };
}

/**
 * 生成针对任务复杂度的执行建议
 */
export function getExecutionGuidance(classification: TaskClassification): string {
  switch (classification.complexity) {
    case "simple":
      return [
        "This appears to be a simple task that can be handled with direct tool calls.",
        "Use browseSymbols or exploreCode to locate information, then answer immediately.",
        "Avoid creating subagents unless the direct approach fails.",
      ].join(" ");

    case "medium":
      return [
        "This is a medium-complexity task that may benefit from structured exploration.",
        "Consider using one or two subagents if the task has distinct phases (explore → implement).",
        "For single-file changes, direct tool calls may suffice.",
      ].join(" ");

    case "complex":
      return [
        "This is a complex task requiring multi-phase coordination.",
        "Use spawnSubagent to delegate independent work:",
        "1. Parallel explorers to locate different parts of the codebase",
        "2. A planner to synthesize findings and design the approach",
        "3. Parallel executors to implement changes across multiple files",
        "Coordinate results with waitForSubagents.",
      ].join(" ");
  }
}
