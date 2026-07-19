import { describe, it, expect } from "vitest";
import { createConversationStore } from "../../../src/extension/conversation/conversationStore";

describe("createConversationStore (in-memory fallback)", () => {
  it("has nothing to restore on a fresh store", () => {
    const store = createConversationStore();
    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("clearActiveConversation is a safe no-op and does not touch existing conversations", () => {
    const store = createConversationStore();
    const context = store.createConversation();

    store.clearActiveConversation();

    // 内存实现支持多个并存对话，clearActiveConversation 是空操作
    expect(store.getConversation(context.conversationId)).toEqual(context);
  });

  it("listConversations returns every conversation, most recently created first, with a preview", () => {
    const store = createConversationStore();
    const first = store.createConversation();
    store.addMessage(first.conversationId, { role: "user", content: "What is TypeScript?" });

    const second = store.createConversation();
    store.addMessage(second.conversationId, { role: "user", content: "And Rust?" });

    expect(store.listConversations()).toEqual([
      { conversationId: second.conversationId, updatedAt: expect.any(Number), preview: "And Rust?" },
      { conversationId: first.conversationId, updatedAt: expect.any(Number), preview: "What is TypeScript?" },
    ]);
  });

  it("setActiveConversation looks up an existing conversation by id", () => {
    const store = createConversationStore();
    const context = store.createConversation();

    expect(store.setActiveConversation(context.conversationId)).toEqual(context);
    expect(store.setActiveConversation("nonexistent")).toBeUndefined();
  });
});
