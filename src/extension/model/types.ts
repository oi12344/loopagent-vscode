export type ModelRole = "system" | "user" | "assistant" | "tool";

export type ModelToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ModelMessage =
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
      content: string;
      toolCallId: string;
      name?: string;
    };

export type ModelRequest = {
  messages: ModelMessage[];
  signal: AbortSignal;
  tools?: ModelToolDefinition[];
  toolChoice?: "auto" | "none";
};

export type ModelStreamEvent =
  | {
      type: "contentDelta";
      content: string;
    }
  | {
      type: "reasoningDelta";
      content: string;
    }
  | {
      type: "usage";
      usage: unknown;
    }
  | {
      type: "toolCallDelta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "finishReason";
      reason: string;
    };

export type ModelProvider = {
  id: string;
  displayName: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
};

export type ModelProviderErrorCode =
  | "missing_api_key"
  | "authentication_failed"
  | "insufficient_balance"
  | "invalid_parameters"
  | "rate_limited"
  | "server_error"
  | "server_overloaded"
  | "request_failed";

export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode;
  readonly status?: number;

  constructor(code: ModelProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ModelProviderError";
    this.code = code;
    this.status = status;
  }
}
