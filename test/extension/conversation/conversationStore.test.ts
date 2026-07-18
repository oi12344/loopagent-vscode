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
});
