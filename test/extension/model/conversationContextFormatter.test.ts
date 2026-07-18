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
      { role: "user", content: "Q2" },
    ];

    const result = formatConversationContext(messages, "Q3");

    expect(result.messageHistory).toHaveLength(4);
    expect(result.messageHistory[0]).toEqual({ role: "user", content: "Q1" });
    expect(result.messageHistory[1]).toEqual({ role: "assistant", content: "A1" });
    expect(result.messageHistory[2]).toEqual({ role: "user", content: "Q2" });
    expect(result.messageHistory[3]).toEqual({ role: "user", content: "Q3" });
  });

  it("system prompt contains LoopAgent description", () => {
    const result = formatConversationContext([], "test");
    expect(result.systemPrompt).toContain("LoopAgent");
    expect(result.systemPrompt).toContain("VSCode");
    expect(result.systemPrompt).toContain("coding tasks");
  });
});
