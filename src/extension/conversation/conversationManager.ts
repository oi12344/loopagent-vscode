import type { ConversationContext, ChatMessage } from "../../shared/chatTypes";
import type { ConversationStore } from "./conversationStore";

/**
 * 对话管理接口
 * 提供高级的对话管理操作，封装对话存储的低级接口
 */
export type ConversationManager = {
  /**
   * 开始一个新的对话
   *
   * @returns 新对话的上下文
   */
  startConversation(): ConversationContext;

  /**
   * 添加用户消息到对话
   *
   * @param conversationId - 对话ID
   * @param userMessage - 用户消息内容
   * @remarks 如果对话不存在，该操作会被忽略（不会抛出异常）
   */
  addUserMessage(conversationId: string, userMessage: string): void;

  /**
   * 添加助手消息到对话
   *
   * @param conversationId - 对话ID
   * @param assistantMessage - 助手消息内容
   * @param reasoning - 可选的思考过程内容
   * @remarks 如果对话不存在，该操作会被忽略（不会抛出异常）
   */
  addAssistantMessage(conversationId: string, assistantMessage: string, reasoning?: string): void;

  /**
   * 获取对话的消息历史
   *
   * @param conversationId - 对话ID
   * @returns 对话的消息列表，如果对话不存在返回空数组
   */
  getConversationHistory(conversationId: string): ChatMessage[];
};

/**
 * 创建一个对话管理器实例
 *
 * @param store - 底层的对话存储服务
 * @returns 对话管理器实例
 * @remarks
 * 对话管理器是对对话存储的高级封装，提供更方便的 API：
 * - 直接添加字符串消息，而不需要手动构造 ChatMessage 对象
 * - 自动处理消息角色（user/assistant）的设置
 */
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

    addAssistantMessage(conversationId: string, assistantMessage: string, reasoning?: string): void {
      store.addMessage(conversationId, {
        role: "assistant",
        content: assistantMessage,
        reasoning,
      });
    },

    getConversationHistory(conversationId: string): ChatMessage[] {
      return store.getMessages(conversationId);
    },
  };
}
