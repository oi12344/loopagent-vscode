import type { ChatMessage } from "../../shared/chatTypes";

/**
 * 格式化后的对话上下文
 */
export type FormattedContext = {
  systemPrompt: string;
  messageHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
};

/**
 * 将聊天消息转换为模型 API 格式
 * @param messages - 对话历史消息
 * @param currentTask - 当前用户输入/任务
 * @returns 包含系统提示和消息历史的格式化上下文
 */
export function formatConversationContext(
  messages: ChatMessage[],
  currentTask: string,
): FormattedContext {
  const systemPrompt = `You are LoopAgent, an AI assistant in VSCode helping developers.

**Capabilities:**
- Read and understand workspace code structure
- Propose file edits with explanations
- Execute code analysis tasks
- Access workspace intelligence (code symbols, structure)

**Constraints:**
- Be concise and direct
- Explain code changes clearly
- Follow TypeScript/JavaScript best practices
- Respect user language preferences (default: English)

**Available Tools:**
- exploreCode: Search and understand code
- readFile: Access file contents
- applyEdit: Make code changes

When proposing changes, always explain your reasoning.`;

  if (messages.length === 0) {
    return {
      systemPrompt,
      messageHistory: [
        {
          role: "user",
          content: currentTask,
        },
      ],
    };
  }

  const messageHistory = messages.map((msg) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));

  // 仅在适当时追加新用户消息：最后一条消息必须是 assistant
  if (messageHistory.length === 0 || messageHistory[messageHistory.length - 1].role === "assistant") {
    messageHistory.push({
      role: "user",
      content: currentTask,
    });
  }

  return {
    systemPrompt,
    messageHistory,
  };
}
