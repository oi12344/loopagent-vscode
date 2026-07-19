import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("assistant messages with reasoning are stored correctly", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);
    const context = manager.startConversation();

    manager.addAssistantMessage(context.conversationId, "Response", "Thought process here");

    const history = manager.getConversationHistory(context.conversationId);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      role: "assistant",
      content: "Response",
      reasoning: "Thought process here"
    });
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

  it("handles messages for non-existent conversation gracefully", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    // 不应该抛异常，只是忽略消息
    manager.addUserMessage("non-existent-id", "test");
    const history = manager.getConversationHistory("non-existent-id");
    expect(history).toEqual([]);
  });

  it("distinguishes between empty and non-existent conversations", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    const context = manager.startConversation();
    // 空对话的消息
    const emptyHistory = manager.getConversationHistory(context.conversationId);
    // 不存在的对话的消息
    const nonExistentHistory = manager.getConversationHistory("fake-id");

    // 两者目前都返回 []
    expect(emptyHistory).toEqual([]);
    expect(nonExistentHistory).toEqual([]);
  });

  it("timestamps are updated when adding messages", () => {
    vi.useFakeTimers();

    const store = createConversationStore();
    const manager = createConversationManager(store);

    const context = manager.startConversation();
    const initialUpdatedAt = context.updatedAt;

    // 获取对话以验证时间戳
    const contextAfter = store.getConversation(context.conversationId);
    expect(contextAfter?.updatedAt).toBe(initialUpdatedAt);

    // 使用初始时间戳作为参考，设置10ms后的时间
    vi.setSystemTime(new Date(initialUpdatedAt + 10));

    manager.addUserMessage(context.conversationId, "Hello");

    const contextAfterMessage = store.getConversation(context.conversationId);
    expect(contextAfterMessage?.updatedAt).toBeGreaterThan(initialUpdatedAt);

    vi.useRealTimers();
  });

  it("conversation IDs are unique", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const context = manager.startConversation();
      expect(ids.has(context.conversationId)).toBe(false);
      ids.add(context.conversationId);
    }

    expect(ids.size).toBe(100);
  });

  it("conversation has createdAt and updatedAt timestamps", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    const beforeCreation = Date.now();
    const context = manager.startConversation();
    const afterCreation = Date.now();

    expect(context.createdAt).toBeGreaterThanOrEqual(beforeCreation);
    expect(context.createdAt).toBeLessThanOrEqual(afterCreation);
    expect(context.updatedAt).toBe(context.createdAt);
  });

  it("multiple messages maintain correct order", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);
    const context = manager.startConversation();

    manager.addUserMessage(context.conversationId, "First");
    manager.addAssistantMessage(context.conversationId, "Response 1");
    manager.addUserMessage(context.conversationId, "Second");
    manager.addAssistantMessage(context.conversationId, "Response 2");

    const history = manager.getConversationHistory(context.conversationId);
    expect(history).toHaveLength(4);
    expect(history[0].content).toBe("First");
    expect(history[1].content).toBe("Response 1");
    expect(history[2].content).toBe("Second");
    expect(history[3].content).toBe("Response 2");
  });

  it("delegates loadActiveConversation and clearActiveConversation to the store", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    expect(manager.loadActiveConversation()).toBeUndefined();

    manager.startConversation();
    expect(() => manager.clearActiveConversation()).not.toThrow();
  });

  it("delegates listConversations, getConversation and setActiveConversation to the store", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    const first = manager.startConversation();
    manager.addUserMessage(first.conversationId, "Hello");
    manager.startConversation();

    expect(manager.listConversations()).toHaveLength(2);
    expect(manager.getConversation(first.conversationId)?.conversationId).toBe(first.conversationId);
    expect(manager.setActiveConversation(first.conversationId)?.conversationId).toBe(first.conversationId);
    expect(manager.getConversation("nonexistent")).toBeUndefined();
  });
});
