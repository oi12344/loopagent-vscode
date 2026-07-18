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

    // 内存实现本来就没有"单活跃对话"的概念（一直支持多个并存的对话，
    // 见 test/extension/multiTurnConversation.integration.test.ts 的
    // "maintains separate conversations independently"），clearActiveConversation
    // 在这里只是满足接口，不做任何删除。
    expect(store.getConversation(context.conversationId)).toEqual(context);
  });
});
