export type ReactAgentMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
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
  input: unknown;
};

export type ReactAgentToolInvocation = {
  request: ReactAgentToolRequest;
  input: unknown;
  signal: AbortSignal;
};

export type ReactAgentTool = {
  name: string;
  invoke(invocation: ReactAgentToolInvocation): string | Promise<string>;
};

export type ReactModelTurnResult =
  | {
      kind: "final";
      content: string;
    }
  | {
      kind: "toolRequests";
      requests: ReactAgentToolRequest[];
    };

export type ReactModelTurn = (input: {
  messages: ReactAgentMessage[];
  signal: AbortSignal;
}) => Promise<ReactModelTurnResult>;
