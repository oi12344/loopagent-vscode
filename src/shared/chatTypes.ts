export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
};

export type ConversationContext = {
  conversationId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

/** 历史对话列表项：只带预览信息，不带完整消息 */
export type ConversationSummary = {
  conversationId: string;
  updatedAt: number;
  preview: string;
};

export type InterruptedRunCheckpoint = {
  version: 1;
  conversationId: string;
  runId: string;
  task: string;
  model?: {
    provider: "deepseek";
    model: string;
    thinking: "disabled" | "enabled";
  };
  step: number;
  messages: Array<Record<string, unknown>>;
  updatedAt: number;
};

export type ConversationTurn =
  | {
      id: string;
      conversationId: string;
      userMessage: string;
      status: "pending";
    }
  | {
      id: string;
      conversationId: string;
      userMessage: string;
      status: "processing";
    }
  | {
      id: string;
      conversationId: string;
      userMessage: string;
      assistantMessage: string;
      status: "completed";
    }
  | {
      id: string;
      conversationId: string;
      userMessage: string;
      status: "error";
      error: string;
    };
