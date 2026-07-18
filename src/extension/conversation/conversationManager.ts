import type { ConversationContext, ChatMessage } from "../../shared/chatTypes";
import type { ConversationStore } from "./conversationStore";

export type ConversationManager = {
  startConversation(): ConversationContext;
  addUserMessage(conversationId: string, userMessage: string): void;
  addAssistantMessage(conversationId: string, assistantMessage: string): void;
  getConversationHistory(conversationId: string): ChatMessage[];
};

export function createConversationManager(store: ConversationStore): ConversationManager {
  return {
    startConversation(): ConversationContext {
      return store.createConversation();
    },

    addUserMessage(conversationId: string, userMessage: string): void {
      store.addMessage(conversationId, {
        role: "user",
        content: userMessage,
      });
    },

    addAssistantMessage(conversationId: string, assistantMessage: string): void {
      store.addMessage(conversationId, {
        role: "assistant",
        content: assistantMessage,
      });
    },

    getConversationHistory(conversationId: string): ChatMessage[] {
      return store.getMessages(conversationId);
    },
  };
}
