import { describe, it, expect } from "vitest";
import { createConversationStore } from "../../../src/extension/conversation/conversationStore";
import { createConversationManager } from "../../../src/extension/conversation/conversationManager";

describe("ConversationManager", () => {
  it("starts a new conversation", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);
    const context = manager.startConversation();

    expect(context.conversationId).toMatch(/^conv-/);
    expect(context.messages).toEqual([]);
  });

  it("adds user and assistant messages to conversation", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);
    const context = manager.startConversation();

    manager.addUserMessage(context.conversationId, "Hello");
    manager.addAssistantMessage(context.conversationId, "Hi there");

    const history = manager.getConversationHistory(context.conversationId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("maintains separate conversations", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    const conv1 = manager.startConversation();
    const conv2 = manager.startConversation();

    manager.addUserMessage(conv1.conversationId, "Message in conv1");
    manager.addUserMessage(conv2.conversationId, "Message in conv2");

    expect(manager.getConversationHistory(conv1.conversationId)).toHaveLength(1);
    expect(manager.getConversationHistory(conv2.conversationId)).toHaveLength(1);
  });
});
