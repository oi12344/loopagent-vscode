export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationContext = {
  conversationId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export type ConversationTurn =
  | {
      id: string;
      conversationId: string;
      userMessage: string;
      status: "pending" | "processing";
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
