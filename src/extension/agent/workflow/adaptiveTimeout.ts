import type { HostToWebviewMessage } from "../../../shared/messages";

/**
 * 自适应超时策略
 * 根据子代理的工具调用模式动态调整超时时长
 */

export type TimeoutAdjustment = {
  shouldExtend: boolean;
  reason: string;
  suggestedMultiplier: number;
};

/**
 * 判断是否应该延长超时时间
 *
 * @param messages 子代理的所有消息
 * @param recentWindowSize 最近观察窗口的消息数（默认5）
 * @returns 超时调整建议
 */
export function evaluateTimeoutAdjustment(
  messages: readonly HostToWebviewMessage[],
  recentWindowSize = 5,
): TimeoutAdjustment {
  if (messages.length < 3) {
    // 刚启动，给予默认时间
    return {
      shouldExtend: false,
      reason: "Too few messages to evaluate pattern",
      suggestedMultiplier: 1.0,
    };
  }

  const recentMessages = messages.slice(-recentWindowSize);
  const recentToolCalls = extractToolCalls(recentMessages);

  // 策略1：工具多样性检测
  const uniqueTools = new Set(recentToolCalls.map((call) => call.toolName));
  const diversityScore = uniqueTools.size / Math.max(recentToolCalls.length, 1);

  if (diversityScore >= 0.6 && recentToolCalls.length >= 3) {
    // 最近的调用有60%以上是不同工具 → 正在多角度探索
    return {
      shouldExtend: true,
      reason: `High tool diversity (${uniqueTools.size}/${recentToolCalls.length} unique), actively exploring`,
      suggestedMultiplier: 1.5,
    };
  }

  // 策略2：单一重复工具检测
  if (diversityScore < 0.3 && recentToolCalls.length >= 3) {
    // 最近的调用中工具重复度很高 → 可能陷入循环或死磕一个问题
    const mostCommonTool = findMostCommonTool(recentToolCalls);
    return {
      shouldExtend: false,
      reason: `Low tool diversity, repeating ${mostCommonTool} (${recentToolCalls.length} recent calls)`,
      suggestedMultiplier: 0.8,
    };
  }

  // 策略3：长时间运行的工具检测
  const hasLongRunningTool = detectLongRunningTools(recentMessages);
  if (hasLongRunningTool) {
    return {
      shouldExtend: true,
      reason: "Detected long-running tool (test/build/compile), extending timeout",
      suggestedMultiplier: 2.0,
    };
  }

  // 策略4：稳定推进模式
  const hasConsistentProgress = checkConsistentProgress(messages);
  if (hasConsistentProgress) {
    return {
      shouldExtend: true,
      reason: "Consistent progress pattern detected",
      suggestedMultiplier: 1.2,
    };
  }

  // 默认：保持当前超时
  return {
    shouldExtend: false,
    reason: "No clear pattern, maintaining current timeout",
    suggestedMultiplier: 1.0,
  };
}

type ToolCall = {
  toolName: string;
  input: string;
};

function extractToolCalls(messages: readonly HostToWebviewMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    if (message.type === "toolCallStarted") {
      calls.push({ toolName: message.toolName, input: message.input });
    }
  }
  return calls;
}

function findMostCommonTool(calls: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
  }
  let maxCount = 0;
  let mostCommon = "unknown";
  for (const [tool, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = tool;
    }
  }
  return mostCommon;
}

/**
 * 检测是否正在运行长时间工具（测试、构建、编译）
 */
function detectLongRunningTools(messages: readonly HostToWebviewMessage[]): boolean {
  const longRunningPatterns = [
    /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
    /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
    /\bcargo\s+(test|build)\b/,
    /\bgo\s+(test|build)\b/,
    /\bmvn\s+(test|compile)\b/,
    /\bgradle\s+(test|build)\b/,
  ];

  for (const message of messages) {
    if (message.type === "toolCallStarted" && message.toolName === "runCommand") {
      const command = message.input;
      if (longRunningPatterns.some((pattern) => pattern.test(command))) {
        // 检查这个命令是否还在运行（未 finished）
        const callId = message.callId;
        const finished = messages.some(
          (m) => m.type === "toolCallFinished" && m.callId === callId,
        );
        if (!finished) return true;
      }
    }
  }

  return false;
}

/**
 * 检查是否有稳定的推进模式（持续产生新的不同内容）
 */
function checkConsistentProgress(messages: readonly HostToWebviewMessage[]): boolean {
  if (messages.length < 10) return false;

  // 检查最近10条消息中是否有多样的活动
  const recent10 = messages.slice(-10);
  const eventTypes = new Set<string>();

  for (const message of recent10) {
    if (message.type === "toolCallStarted") eventTypes.add(`tool:${message.toolName}`);
    if (message.type === "agentEvent") eventTypes.add("agent");
    if (message.type === "assistantThinking") eventTypes.add("thinking");
  }

  // 如果有3种以上不同类型的活动 → 稳定推进
  return eventTypes.size >= 3;
}
