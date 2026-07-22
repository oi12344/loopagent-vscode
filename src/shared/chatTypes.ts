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
  mode?: "ask" | "edit";
  model?: {
    provider: "deepseek";
    model: string;
    thinking: "disabled" | "enabled";
  };
  step: number;
  messages: Array<Record<string, unknown>>;
  updatedAt: number;
};

export type WorkflowPhase =
  | "bootstrap"
  | "route"
  | "brainstorming"
  | "designApproval"
  | "writeSpec"
  | "specReview"
  | "writePlan"
  | "planApproval"
  | "preflight"
  | "implement"
  | "review"
  | "fix"
  | "finalReview"
  | "verification"
  | "finished"
  | "blocked";

export type SuperpowersCheckpoint = {
  version: 1;
  conversationId: string;
  runId: string;
  phase: WorkflowPhase;
  skillNames: string[];
  planPath?: string;
  taskIndex: number;
  activeAgentId?: string;
  waitingFor?: string;
  baseCommit?: string;
  updatedAt: number;
};

const workflowPhases: readonly WorkflowPhase[] = [
  "bootstrap", "route", "brainstorming", "designApproval", "writeSpec", "specReview", "writePlan", "planApproval",
  "preflight", "implement", "review", "fix", "finalReview", "verification", "finished", "blocked",
];

export function isSuperpowersCheckpoint(value: unknown, conversationId: string): value is SuperpowersCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Partial<SuperpowersCheckpoint>;
  return checkpoint.version === 1
    && checkpoint.conversationId === conversationId
    && typeof checkpoint.runId === "string"
    && workflowPhases.includes(checkpoint.phase as WorkflowPhase)
    && Array.isArray(checkpoint.skillNames) && checkpoint.skillNames.every((name) => typeof name === "string")
    && typeof checkpoint.taskIndex === "number" && Number.isInteger(checkpoint.taskIndex) && checkpoint.taskIndex >= 0
    && typeof checkpoint.updatedAt === "number"
    && [checkpoint.planPath, checkpoint.activeAgentId, checkpoint.waitingFor, checkpoint.baseCommit]
      .every((field) => field === undefined || typeof field === "string");
}

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
