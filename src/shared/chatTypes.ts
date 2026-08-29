export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  runId?: string;
  workflow?: {
    phase?: string;
    agents: Array<{
      id: string;
      task: string;
      role?: "explorer" | "reviewer" | "planner" | "executor";
      dependsOn: string[];
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
    }>;
    step?: number;
    stateVersion?: number;
    stopReason?: string;
  };
  appliedEdits?: Array<{
    notificationId: string;
    files: string[];
    fileStats: Array<{ path: string; added: number; removed: number }>;
    error?: string;
  }>;
};

export type CodeReviewSeverity = "error" | "warning" | "info";
export type CodeReviewCategory = "bug" | "style" | "performance" | "security" | "maintainability";

export type CodeReviewIssue = {
  severity: CodeReviewSeverity;
  category: CodeReviewCategory;
  filePath: string;
  line: number;
  message: string;
  suggestion?: string;
};

export type CodeReviewConfig = {
  maxIssues?: number;
  severityFilter?: CodeReviewSeverity[];
};

export type CodeReviewReport = {
  id: string;
  timestamp: number;
  targetPath: string;
  assessment: number;
  summary: string;
  totalIssues: number;
  issuesBySeverity: Record<CodeReviewSeverity, number>;
  issuesByCategory: Record<CodeReviewCategory, number>;
  issues: CodeReviewIssue[];
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
  mode?: "plan" | "execute";
  commandPermission?: "ask" | "full";
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
