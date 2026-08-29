import type { ReactAgentMessage } from "./reactTypes";

/** 消息类型约束：compression 只关心 role、content、reasoning、toolCalls */
type CompressibleMessage = {
  role: string;
  content: string;
  reasoningContent?: string;
  reasoning?: string;
  toolCalls?: unknown[];
  name?: string;
};

/**
 * 对话历史压缩策略
 *
 * 基于 token 预算触发，而非消息数量。
 * 摘要包含关键结论（用户问题、工具名称、核心发现），
 * 旧的工具结果自动过期淘汰。
 */

export type MessageCompressionOptions = {
  /** 触发压缩的 token 阈值（默认 8000，约 32K 上下文的 25%） */
  maxTokens: number;
  /** 压缩后保留的最近 token 数（默认 3000） */
  keepRecentTokens: number;
  /** 工具结果过期窗口：超过此 token 数的旧工具结果被淘汰（默认 4000） */
  toolResultExpiryTokens: number;
};

const DEFAULT_OPTIONS: MessageCompressionOptions = {
  maxTokens: 8_000,
  keepRecentTokens: 3_000,
  toolResultExpiryTokens: 4_000,
};

/**
 * 压缩对话历史
 *
 * 流程：
 * 1. 淘汰过期的工具结果（节省 token）
 * 2. 如果仍超 token 阈值，压缩中间消息为摘要
 * 3. 摘要包含关键结论，不只是数字统计
 */
export function compressConversationHistory(
  messages: CompressibleMessage[],
  options: Partial<MessageCompressionOptions> = {},
): CompressibleMessage[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 分离系统消息和非系统消息
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length === 0) return messages;

  // Step 1: 淘汰过期的工具结果
  let working = expireOldToolResults(nonSystemMessages, opts.toolResultExpiryTokens);

  // Step 2: 检查是否需要压缩
  const currentTokens = estimateTokenCount([...systemMessages, ...working]);
  if (currentTokens <= opts.maxTokens) {
    return [...systemMessages, ...working];
  }

  // Step 3: 保留最近的消息，压缩中间部分
  const keepRecent = takeRecentByTokens(working, opts.keepRecentTokens);
  const toCompress = working.slice(0, working.length - keepRecent.length);

  if (toCompress.length > 0) {
    const summary = summarizeMessages(toCompress);
    const summaryMessage: CompressibleMessage = {
      role: "user",
      content: `[对话历史摘要: 已压缩 ${toCompress.length} 条消息，节省约 ${currentTokens - estimateTokenCount([...systemMessages, ...keepRecent])} tokens]\n\n${summary}`,
    };
    return [...systemMessages, summaryMessage, ...keepRecent];
  }

  return [...systemMessages, ...working];
}

/**
 * 淘汰过期的工具结果
 *
 * 保留最近的工具结果，淘汰早期的（它们通常已过时）。
 * 保留策略：最近的 tool result 保留，更早的被淘汰。
 */
function expireOldToolResults(
  messages: CompressibleMessage[],
  expiryTokens: number,
): CompressibleMessage[] {
  const result: CompressibleMessage[] = [];
  let toolResultTokens = 0;

  // 从后往前遍历，保留最近的工具结果
  const toolResultIndices = new Set<number>();
  let tokensFromEnd = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      tokensFromEnd += estimateTextTokens(messages[i].content);
      if (tokensFromEnd <= expiryTokens) {
        toolResultIndices.add(i);
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool" && !toolResultIndices.has(i)) {
      // 淘汰过期的工具结果，替换为简短占位
      result.push({
        role: "tool",
        content: "[工具结果已过期，省略]",
        name: messages[i].name,
      });
    } else {
      result.push(messages[i]);
    }
  }

  return result;
}

/**
 * 从消息列表尾部按 token 预算取最近的消息
 */
function takeRecentByTokens(
  messages: CompressibleMessage[],
  maxTokens: number,
): CompressibleMessage[] {
  const result: CompressibleMessage[] = [];
  let tokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTextTokens(messages[i].content);
    if (tokens + msgTokens > maxTokens && result.length > 0) break;
    tokens += msgTokens;
    result.unshift(messages[i]);
  }

  return result;
}

/**
 * 将消息列表总结为包含关键结论的摘要
 *
 * 提取：用户问题主题、使用的工具、核心发现
 */
function summarizeMessages(messages: CompressibleMessage[]): string {
  const lines: string[] = [];

  // 提取用户问题主题
  const userQuestions = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim().slice(0, 80))
    .filter((q) => q.length > 0);

  if (userQuestions.length > 0) {
    lines.push("## 用户问题");
    for (const q of userQuestions.slice(0, 5)) {
      lines.push(`- ${q}`);
    }
  }

  // 提取使用的工具名称（去重）
  const toolNames = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.name) {
      toolNames.add(msg.name);
    }
  }
  if (toolNames.size > 0) {
    lines.push(`\n## 使用的工具: ${[...toolNames].join(", ")}`);
  }

  // 提取助手回复的关键发现（取前 3 条的前 100 字符）
  const assistantSummaries = messages
    .filter((m) => m.role === "assistant" && m.content.length > 20)
    .map((m) => m.content.trim().slice(0, 100))
    .slice(0, 3);

  if (assistantSummaries.length > 0) {
    lines.push("\n## 关键发现");
    for (const s of assistantSummaries) {
      lines.push(`- ${s}`);
    }
  }

  // 统计信息
  const toolCallCount = messages.filter(
    (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
  ).length;

  lines.push(`\n## 统计`);
  lines.push(`- ${messages.length} 条消息`);
  if (toolCallCount > 0) lines.push(`- ${toolCallCount} 次工具调用`);

  return lines.join("\n");
}

/**
 * 估算单段文本的 token 数量（内容感知）
 *
 * 中文约 1.5-2 字符/token，英文约 4 字符/token，代码约 3 字符/token。
 * 通过检测中文字符比例来调整估算。
 */
function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 统计中文字符比例
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const ratio = cjkChars / text.length;

  // 根据中文比例加权：中文多用 2:1，英文多用 4:1
  const charsPerToken = 4 - ratio * 2; // ratio=0 → 4, ratio=1 → 2
  return Math.ceil(text.length / charsPerToken);
}

/**
 * 估算消息列表的 token 数量（内容感知）
 *
 * @param messages 消息列表
 * @returns 估算的 token 数量
 */
export function estimateTokenCount(messages: CompressibleMessage[]): number {
  let totalTokens = 0;

  for (const msg of messages) {
    totalTokens += estimateTextTokens(msg.content);
    const reasoning = msg.reasoningContent ?? msg.reasoning;
    if (msg.role === "assistant" && reasoning) {
      totalTokens += estimateTextTokens(reasoning);
    }
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        totalTokens += estimateTextTokens(JSON.stringify(call));
      }
    }
  }

  return totalTokens;
}
