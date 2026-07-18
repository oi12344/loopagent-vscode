import type { ConversationContext, ChatMessage } from "../../shared/chatTypes";

export type ConversationStore = {
  createConversation(): ConversationContext;
  getConversation(conversationId: string): ConversationContext | undefined;
  addMessage(conversationId: string, message: ChatMessage): void;
  getMessages(conversationId: string): ChatMessage[];
};

export function createConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationContext>();

  return {
    createConversation(): ConversationContext {
      const conversationId = `conv-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const context: ConversationContext = {
        conversationId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      conversations.set(conversationId, context);
      return context;
    },

    getConversation(conversationId: string): ConversationContext | undefined {
      return conversations.get(conversationId);
    },

    addMessage(conversationId: string, message: ChatMessage): void {
      const context = conversations.get(conversationId);
      if (context) {
        context.messages.push(message);
        context.updatedAt = Date.now();
      }
    },

    getMessages(conversationId: string): ChatMessage[] {
      const context = conversations.get(conversationId);
      return context?.messages ?? [];
    },
  };
}
