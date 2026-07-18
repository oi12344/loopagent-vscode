import { describe, it, expect } from "vitest";
import { formatConversationContext } from "../../../src/extension/model/conversationContextFormatter";

describe("conversationContextFormatter", () => {
  it("creates initial context for first message", () => {
    const result = formatConversationContext([], "Explain this function");

    expect(result.systemPrompt).toContain("LoopAgent");
    expect(result.messageHistory).toHaveLength(1);
    expect(result.messageHistory[0]).toEqual({
      role: "user",
      content: "Explain this function",
    });
  });

  it("appends task to conversation history", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const result = formatConversationContext(messages, "Next question");

    expect(result.messageHistory).toHaveLength(3);
    expect(result.messageHistory[2]).toEqual({
      role: "user",
      content: "Next question",
    });
  });

  it("preserves existing conversation history", () => {
    const messages = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "assistant", content: "A2" },
    ];

    const result = formatConversationContext(messages, "Q3");

    // 最后一条是 assistant，所以应该追加新 user 消息
    expect(result.messageHistory).toHaveLength(4);
    expect(result.messageHistory[0]).toEqual({ role: "user", content: "Q1" });
    expect(result.messageHistory[1]).toEqual({ role: "assistant", content: "A1" });
    expect(result.messageHistory[2]).toEqual({ role: "assistant", content: "A2" });
    expect(result.messageHistory[3]).toEqual({ role: "user", content: "Q3" });
  });

  it("system prompt contains LoopAgent description", () => {
    const result = formatConversationContext([], "test");
    expect(result.systemPrompt).toContain("LoopAgent");
    expect(result.systemPrompt).toContain("VSCode");
  });

  it("does not append user message if last message is user", () => {
    const messages = [{ role: "user", content: "Q1" }];
    const result = formatConversationContext(messages, "Q2");

    // 当最后一条消息是 user 时，不应该追加新的 user 消息
    // 所以总共只有 1 条消息（原有的 Q1）
    expect(result.messageHistory).toHaveLength(1);
    expect(result.messageHistory[0]).toEqual({
      role: "user",
      content: "Q1",
    });
  });

  it("handles edge case: user followed by assistant followed by new task", () => {
    const messages = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ];
    const result = formatConversationContext(messages, "Q2");

    // 最后一条消息是 assistant，所以应该追加新 user 消息
    // 应该是 Q1, A1, Q2 三条消息
    expect(result.messageHistory).toHaveLength(3);
    expect(result.messageHistory[0]).toEqual({ role: "user", content: "Q1" });
    expect(result.messageHistory[1]).toEqual({
      role: "assistant",
      content: "A1",
    });
    expect(result.messageHistory[2]).toEqual({
      role: "user",
      content: "Q2",
    });
  });

  it("handles empty currentTask", () => {
    const messages = [{ role: "assistant", content: "Response" }];
    const result = formatConversationContext(messages, "");

    expect(result.messageHistory).toHaveLength(2);
    expect(result.messageHistory[1]).toEqual({
      role: "user",
      content: "",
    });
  });

  it("system prompt contains tool descriptions", () => {
    const result = formatConversationContext([], "test");
    expect(result.systemPrompt).toContain("Capabilities");
    expect(result.systemPrompt).toContain("exploreCode");
    expect(result.systemPrompt).toContain("readFile");
    expect(result.systemPrompt).toContain("applyEdit");
  });
});
