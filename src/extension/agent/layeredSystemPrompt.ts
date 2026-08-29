/**
 * 系统提示词分层管理
 *
 * 将系统提示词分为多个层级，每层有不同的优先级和压缩策略
 */

/**
 * 内容感知的 token 估算：中文约 1.5-2 字符/token，英文约 4 字符/token
 */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const ratio = cjkChars / text.length;
  const charsPerToken = 4 - ratio * 2;
  return Math.ceil(text.length / charsPerToken);
}

export type SystemPromptLayer = {
  /** 层级名称 */
  name: string;
  /** 层级内容 */
  content: string;
  /** 优先级（数字越大越重要，越不容易被压缩） */
  priority: number;
  /** 是否可压缩 */
  compressible: boolean;
};

export type LayeredSystemPrompt = {
  /** 各层提示词 */
  layers: SystemPromptLayer[];
  /** 总字符数 */
  totalChars: number;
  /** 估算的 token 数 */
  estimatedTokens: number;
};

/**
 * 创建分层系统提示词
 */
export function createLayeredSystemPrompt(
  basePrompt: string,
  runtimePrompt: string,
  memoryPrompt: string,
  imagePrompt: string,
): LayeredSystemPrompt {
  const layers: SystemPromptLayer[] = [];

  // L1: 基础规则（最高优先级，永不压缩）
  if (basePrompt) {
    layers.push({
      name: "base",
      content: basePrompt,
      priority: 100,
      compressible: false,
    });
  }

  // L2: 运行时上下文（高优先级，可压缩关键信息外的部分）
  if (runtimePrompt) {
    layers.push({
      name: "runtime",
      content: runtimePrompt,
      priority: 80,
      compressible: true,
    });
  }

  // L3: 项目记忆（中优先级，可压缩）
  if (memoryPrompt) {
    layers.push({
      name: "memory",
      content: memoryPrompt,
      priority: 60,
      compressible: true,
    });
  }

  // L2: 图片分析（高优先级，会话相关，不可压缩）
  if (imagePrompt) {
    layers.push({
      name: "image",
      content: imagePrompt,
      priority: 80,
      compressible: false,
    });
  }

  const totalChars = layers.reduce((sum, layer) => sum + layer.content.length, 0);
  const estimatedTokens = layers.reduce((sum, layer) => sum + estimateTokens(layer.content), 0);

  return {
    layers,
    totalChars,
    estimatedTokens,
  };
}

/**
 * 将分层提示词渲染为单个字符串
 */
export function renderLayeredPrompt(layered: LayeredSystemPrompt): string {
  // 按优先级排序（高优先级在前）
  const sorted = [...layered.layers].sort((a, b) => b.priority - a.priority);
  return sorted.map((layer) => layer.content).join("\n\n");
}

/**
 * 将分层提示词渲染为多个消息（实验性）
 */
export function renderAsMultipleMessages(layered: LayeredSystemPrompt): Array<{
  role: "system";
  content: string;
  layer: string;
}> {
  return layered.layers
    .sort((a, b) => b.priority - a.priority)
    .map((layer) => ({
      role: "system" as const,
      content: layer.content,
      layer: layer.name,
    }));
}

/**
 * 压缩分层提示词（当上下文预算紧张时）
 */
export function compressLayeredPrompt(
  layered: LayeredSystemPrompt,
  targetTokens: number,
): LayeredSystemPrompt {
  const currentTokens = layered.estimatedTokens;

  // 如果已经在预算内，不压缩
  if (currentTokens <= targetTokens) {
    return layered;
  }

  // 需要减少的 token 数
  const tokensToSave = currentTokens - targetTokens;

  // 按优先级排序（低优先级先压缩）
  const sortedLayers = [...layered.layers].sort((a, b) => a.priority - b.priority);

  const compressedLayers: SystemPromptLayer[] = [];
  let savedTokens = 0;

  for (const layer of sortedLayers) {
    if (savedTokens >= tokensToSave) {
      // 已经节省足够，保留剩余层
      compressedLayers.push(layer);
      continue;
    }

    if (!layer.compressible) {
      // 不可压缩层，完整保留
      compressedLayers.push(layer);
      continue;
    }

    // 可压缩层：生成摘要
    const layerTokens = estimateTokens(layer.content);
    const summary = summarizeLayer(layer);
    const summaryTokens = estimateTokens(summary);
    const saved = layerTokens - summaryTokens;

    compressedLayers.push({
      ...layer,
      content: summary,
    });

    savedTokens += saved;
  }

  const totalChars = compressedLayers.reduce((sum, layer) => sum + layer.content.length, 0);

  return {
    layers: compressedLayers,
    totalChars,
    estimatedTokens: compressedLayers.reduce((sum, layer) => sum + estimateTokens(layer.content), 0),
  };
}

/**
 * 为某一层生成摘要
 */
function summarizeLayer(layer: SystemPromptLayer): string {
  switch (layer.name) {
    case "runtime":
      // 运行时上下文：只保留关键路径和状态
      return `[运行时上下文摘要]\n${extractKeyRuntimeInfo(layer.content)}`;

    case "memory":
      // 项目记忆：只保留关键决策和约束
      return `[项目记忆摘要]\n${extractKeyMemoryInfo(layer.content)}`;

    default:
      // 默认：截断前 500 字符
      return layer.content.slice(0, 500) + "\n\n[... 内容已压缩]";
  }
}

/**
 * 提取运行时上下文的关键信息
 */
function extractKeyRuntimeInfo(content: string): string {
  const lines: string[] = [];

  // 提取工作区根目录
  const workspaceMatch = content.match(/workspace.*?:\s*(.+)/i);
  if (workspaceMatch) {
    lines.push(`工作区: ${workspaceMatch[1]}`);
  }

  // 提取 git 分支
  const branchMatch = content.match(/branch.*?:\s*(.+)/i);
  if (branchMatch) {
    lines.push(`分支: ${branchMatch[1]}`);
  }

  // 提取修改文件数（如果有）
  const modifiedMatch = content.match(/(\d+)\s+file.*?modified/i);
  if (modifiedMatch) {
    lines.push(`修改文件: ${modifiedMatch[1]} 个`);
  }

  return lines.join("\n");
}

/**
 * 提取项目记忆的关键信息
 */
function extractKeyMemoryInfo(content: string): string {
  const lines: string[] = [];

  // 提取关键决策（假设格式为 "决策：..."）
  const decisions = content.match(/决策[:：](.+)/gi) || [];
  decisions.slice(0, 3).forEach((decision) => {
    lines.push(decision);
  });

  // 提取约束（假设格式为 "约束：..."）
  const constraints = content.match(/约束[:：](.+)/gi) || [];
  constraints.slice(0, 3).forEach((constraint) => {
    lines.push(constraint);
  });

  return lines.length > 0 ? lines.join("\n") : "项目记忆已加载";
}
