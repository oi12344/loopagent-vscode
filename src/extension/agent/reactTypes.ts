import type { ModelToolCall, ModelToolChoice } from "../model/types";
import type { MemoryEvidence, ReactAgentRunOutcome } from "../memory/types";

export type { ReactAgentRunOutcome } from "../memory/types";

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
  parseError?: string;
};

export type ReactAgentToolInvocation = {
  request: ReactAgentToolRequest;
  input: unknown;
  signal: AbortSignal;
};

/** A tool's normalized result: the bounded text appended to ReAct message history, plus
 * zero or more local `MemoryEvidence` the runner accumulates for this run's outcome. Tools
 * may still return a plain string (normalized to `{ content, evidence: [] }` by the
 * registry) for backward compatibility. */
export type ReactAgentToolResult = {
  content: string;
  evidence: MemoryEvidence[];
};

export type ReactAgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isConcurrencySafe?: (input: unknown) => boolean;
  invoke(invocation: ReactAgentToolInvocation): string | ReactAgentToolResult | Promise<string | ReactAgentToolResult>;
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
  toolChoice?: ModelToolChoice;
}) => Promise<ReactModelTurnResult>;
