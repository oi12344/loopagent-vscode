export type ModelRole = "system" | "user" | "assistant" | "tool";

export type ModelMessage = {
  role: ModelRole;
  content: string;
};

export type ModelRequest = {
  messages: ModelMessage[];
  signal: AbortSignal;
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
