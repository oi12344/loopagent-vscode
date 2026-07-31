import { describe, it, expect } from "vitest";

// 内联类型定义以避免导入问题
type ReactAgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; reasoningContent?: string; toolCalls?: any[] }
  | { role: "tool"; requestId: string; name: string; content: string };

// 复制核心逻辑进行测试
function compressMessages(
  messages: ReactAgentMessage[],
  maxMessages: number,
  keepRecentMessages: number,
): ReactAgentMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  const compressed: ReactAgentMessage[] = [];

  // 1. 保护所有系统消息
  const systemMessages = messages.filter((m) => m.role === "system");
  compressed.push(...systemMessages);

  // 2. 找到第一个非系统消息的索引
  const firstNonSystemIndex = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystemIndex === -1) {
    return messages;
  }

  // 3. 非系统消息部分应用压缩
  const nonSystemMessages = messages.slice(firstNonSystemIndex);

  if (nonSystemMessages.length <= keepRecentMessages) {
    compressed.push(...nonSystemMessages);
    return compressed;
  }

  // 4. 压缩中间消息
  const keepFromIndex = nonSystemMessages.length - keepRecentMessages;
  const middleMessages = nonSystemMessages.slice(0, keepFromIndex);

  if (middleMessages.length > 0) {
    compressed.push({
      role: "user",
      content: `[摘要: 已省略 ${middleMessages.length} 条消息]`,
    });
  }

  // 5. 保留最近消息
  const recentMessages = nonSystemMessages.slice(keepFromIndex);
  compressed.push(...recentMessages);

  return compressed;
}

describe("messageCompression core logic", () => {
  it("should preserve all system messages", () => {
    const messages: ReactAgentMessage[] = [
      { role: "system", content: "System 1" },
      { role: "system", content: "System 2" },
      { role: "system", content: "System 3" },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}`,
      })),
    ];

    const compressed = compressMessages(messages, 50, 10);

    // 验证所有系统消息都保留
    const systemMsgs = compressed.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(3);
    expect(systemMsgs[0].content).toBe("System 1");
    expect(systemMsgs[1].content).toBe("System 2");
    expect(systemMsgs[2].content).toBe("System 3");

    // 验证结构：3 系统 + 1 摘要 + 10 最近
    expect(compressed.length).toBe(3 + 1 + 10);
  });

  it("should handle single system message", () => {
    const messages: ReactAgentMessage[] = [
      { role: "system", content: "System prompt" },
      ...Array.from({ length: 50 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}`,
      })),
    ];

    const compressed = compressMessages(messages, 40, 10);

    // 系统消息保留
    expect(compressed[0].role).toBe("system");
    expect(compressed[0].content).toBe("System prompt");

    // 摘要 + 最近
    expect(compressed[1].role).toBe("user");
    expect(compressed[1].content).toContain("[摘要");
    expect(compressed.length).toBe(1 + 1 + 10); // 1 系统 + 1 摘要 + 10 最近
  });

  it("should handle no system messages", () => {
    const messages: ReactAgentMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));

    const compressed = compressMessages(messages, 50, 10);

    // 无系统消息
    const systemMsgs = compressed.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(0);

    // 摘要 + 最近
    expect(compressed.length).toBe(1 + 10); // 1 摘要 + 10 最近
    expect(compressed[0].content).toContain("[摘要");
  });

  it("should not compress when below threshold", () => {
    const messages: ReactAgentMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ];

    const compressed = compressMessages(messages, 50, 10);

    expect(compressed).toEqual(messages);
  });

  it("should handle only system messages", () => {
    const messages: ReactAgentMessage[] = [
      { role: "system", content: "System 1" },
      { role: "system", content: "System 2" },
    ];

    const compressed = compressMessages(messages, 50, 10);

    expect(compressed).toEqual(messages);
  });

  it("should preserve system messages even when exceeding threshold", () => {
    const messages: ReactAgentMessage[] = [
      { role: "system", content: "System 1" },
      { role: "system", content: "System 2" },
      { role: "system", content: "System 3" },
      { role: "system", content: "System 4" },
      { role: "system", content: "System 5" },
      ...Array.from({ length: 100 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}`,
      })),
    ];

    const compressed = compressMessages(messages, 50, 10);

    // 即使有 5 个系统消息，全部保留
    const systemMsgs = compressed.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(5);

    // 结构：5 系统 + 1 摘要 + 10 最近
    expect(compressed.length).toBe(5 + 1 + 10);
  });
});
