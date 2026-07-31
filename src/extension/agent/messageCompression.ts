import type { ReactAgentMessage } from "./reactTypes";

/**
 * 对话历史压缩策略
 *
 * 当消息数量超过阈值时，保留：
 * 1. 系统提示（第一条）
 * 2. 最近的 N 轮对话（用户消息 + 助手回复 + 工具调用结果）
 * 3. 压缩中间的历史为摘要消息
 */

export type MessageCompressionOptions = {
  /** 触发压缩的消息数量阈值 */
  maxMessages: number;
  /** 压缩后保留的最近消息数量 */
  keepRecentMessages: number;
};

const DEFAULT_OPTIONS: MessageCompressionOptions = {
  maxMessages: 50, // 超过 50 条消息时触发压缩
  keepRecentMessages: 20, // 保留最近 20 条消息
};

/**
 * 压缩对话历史
 *
 * @param messages 原始消息列表
 * @param options 压缩选项
 * @returns 压缩后的消息列表
 */
export function compressConversationHistory(
  messages: ReactAgentMessage[],
  options: Partial<MessageCompressionOptions> = {},
): ReactAgentMessage[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 如果消息数量未超过阈值，不压缩
  if (messages.length <= opts.maxMessages) {
    return messages;
  }

  const compressed: ReactAgentMessage[] = [];

  // 1. 保护所有系统消息（可能有多条，永久保留）
  const systemMessages = messages.filter((m) => m.role === "system");
  compressed.push(...systemMessages);

  // 2. 找到第一个非系统消息的索引
  const firstNonSystemIndex = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystemIndex === -1) {
    // 全是系统消息，直接返回
    return messages;
  }

  // 3. 非系统消息部分应用压缩
  const nonSystemMessages = messages.slice(firstNonSystemIndex);

  // 如果非系统消息数量未超过保留阈值，全部保留
  if (nonSystemMessages.length <= opts.keepRecentMessages) {
    compressed.push(...nonSystemMessages);
    return compressed;
  }

  // 4. 找到需要保留的最近消息的起始索引
  const keepFromIndex = nonSystemMessages.length - opts.keepRecentMessages;

  // 5. 压缩中间的消息
  const middleMessages = nonSystemMessages.slice(0, keepFromIndex);
  if (middleMessages.length > 0) {
    const summary = summarizeMessages(middleMessages);
    compressed.push({
      role: "user",
      content: `[对话历史摘要: 已省略 ${middleMessages.length} 条消息]\n\n${summary}`,
    });
  }

  // 6. 保留最近的消息
  const recentMessages = nonSystemMessages.slice(keepFromIndex);
  compressed.push(...recentMessages);

  return compressed;
}

/**
 * 将消息列表总结为简短摘要
 */
function summarizeMessages(messages: ReactAgentMessage[]): string {
  const lines: string[] = [];

  // 统计用户问题和工具调用
  const userQuestions = messages.filter((m) => m.role === "user").length;
  const toolCalls = messages.filter((m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0).length;
  const toolResults = messages.filter((m) => m.role === "tool").length;

  lines.push(`早期对话包含:`);
  lines.push(`- ${userQuestions} 个用户问题`);
  lines.push(`- ${toolCalls} 次工具调用`);
  lines.push(`- ${toolResults} 个工具结果`);

  // 提取关键工具名称（去重）
  const toolNames = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool") {
      toolNames.add(msg.name);
    }
  }

  if (toolNames.size > 0) {
    lines.push(`- 使用的工具: ${[...toolNames].join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * 估算消息列表的 token 数量（粗略估计）
 *
 * @param messages 消息列表
 * @returns 估算的 token 数量
 */
export function estimateTokenCount(messages: ReactAgentMessage[]): number {
  let totalChars = 0;

  for (const msg of messages) {
    totalChars += msg.content.length;
    if (msg.role === "assistant" && msg.reasoningContent) {
      totalChars += msg.reasoningContent.length;
    }
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        totalChars += JSON.stringify(call).length;
      }
    }
  }

  // 粗略估计：4 个字符 ≈ 1 个 token
  return Math.ceil(totalChars / 4);
}
