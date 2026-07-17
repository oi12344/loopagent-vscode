import type { ModelToolCall } from "../model/types";

export type ReactAgentMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      reasoningContent?: string;
      toolCalls?: ModelToolCall[];
    }
  | {
      role: "tool";
      requestId: string;
      name: string;
      content: string;
    };

export type ReactAgentToolRequest = {
  id: string;
  name: string;
  rawArguments: string;
  input: unknown;
};

export type ReactAgentToolInvocation = {
  request: ReactAgentToolRequest;
  input: unknown;
  signal: AbortSignal;
};

export type ReactAgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isConcurrencySafe?: (input: unknown) => boolean;
  invoke(invocation: ReactAgentToolInvocation): string | Promise<string>;
};

export type ReactModelTurnResult =
  | {
      kind: "final";
      content: string;
      reasoning?: string;
    }
  | {
      kind: "toolRequests";
      reasoning?: string;
      assistantMessage: Extract<ReactAgentMessage, { role: "assistant" }>;
      requests: ReactAgentToolRequest[];
    };

export type ReactModelTurn = (input: {
  messages: ReactAgentMessage[];
  signal: AbortSignal;
  toolChoice?: "auto" | "none";
}) => Promise<ReactModelTurnResult>;
