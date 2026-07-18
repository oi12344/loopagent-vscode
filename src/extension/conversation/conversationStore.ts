import type { ConversationContext, ChatMessage } from "../../shared/chatTypes";

/**
 * 对话存储服务
 * 提供对话创建、检索和消息管理的核心功能，使用内存存储。
 */
export type ConversationStore = {
  /**
   * 创建一个新的对话
   *
   * @returns 新创建的对话上下文，包含唯一的对话ID
   */
  createConversation(): ConversationContext;

  /**
   * 获取对话上下文
   *
   * @param conversationId - 对话ID
   * @returns 对话上下文，如果不存在返回 undefined
   */
  getConversation(conversationId: string): ConversationContext | undefined;

  /**
   * 向对话添加消息
   *
   * @param conversationId - 对话ID
   * @param message - 要添加的消息
   * @remarks 如果对话不存在，此操作会被忽略
   */
  addMessage(conversationId: string, message: ChatMessage): void;

  /**
   * 获取对话的所有消息
   *
   * @param conversationId - 对话ID
   * @returns 对话的消息列表，如果对话不存在返回空数组
   */
  getMessages(conversationId: string): ChatMessage[];
};

/**
 * 创建一个新的对话存储实例
 *
 * @returns 对话存储实例，用于管理对话和消息
 * @remarks 存储使用内存实现，使用 Map 保存所有对话的上下文
 */
export function createConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationContext>();

  /**
   * 生成唯一的对话ID
   * 使用时间戳和随机数组合，并检测碰撞
   *
   * @returns 唯一的对话ID
   */
  function generateConversationId(): string {
    let conversationId: string;
    do {
      // 使用时间戳确保单调递增，随机数部分保证高并发下的唯一性
      conversationId = `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    } while (conversations.has(conversationId));
    return conversationId;
  }

  return {
    createConversation(): ConversationContext {
      const conversationId = generateConversationId();
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
