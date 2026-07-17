import type { ModelMessage, ModelProvider, ModelToolCall } from "../model/types";
import type {
  ReactAgentMessage,
  ReactAgentTool,
  ReactAgentToolRequest,
  ReactModelTurn,
} from "./reactTypes";

export type CreateOpenAiReactModelTurnOptions = {
  provider: ModelProvider;
  tools: ReactAgentTool[];
};

type PendingToolCall = {
  id?: string;
  name: string;
  arguments: string;
};

export function createOpenAiReactModelTurn({ provider, tools }: CreateOpenAiReactModelTurnOptions): ReactModelTurn {
  return async ({ messages, signal, toolChoice = "auto" }) => {
    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    const pendingCalls = new Map<number, PendingToolCall>();

    for await (const event of provider.stream({
      messages: messages.map(toModelMessage),
      signal,
      tools:
        toolChoice === "none"
          ? undefined
          : tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
      toolChoice,
    })) {
      if (event.type === "reasoningDelta") {
        reasoning += event.content;
      } else if (event.type === "contentDelta") {
        content += event.content;
      } else if (event.type === "toolCallDelta") {
        const pending = pendingCalls.get(event.index) ?? { name: "", arguments: "" };
        pendingCalls.set(event.index, {
          id: event.id ?? pending.id,
          name: pending.name + (event.name ?? ""),
          arguments: pending.arguments + (event.argumentsDelta ?? ""),
        });
      } else if (event.type === "finishReason") {
        finishReason = event.reason;
      }
    }

    if (pendingCalls.size > 0) {
      if (finishReason !== "tool_calls") {
        throw new Error(`Unexpected finish reason for tool calls: ${finishReason ?? "missing"}`);
      }

      return createToolRequests(pendingCalls, reasoning);
    }

    if (finishReason === "tool_calls") {
      throw new Error("Model finished with tool_calls but returned no tool calls");
    }

    if (content.length > 0) {
      return { kind: "final", content, ...(reasoning ? { reasoning } : {}) };
    }

    throw new Error("Model response was empty");
  };
}

function toModelMessage(message: ReactAgentMessage): ModelMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      toolCallId: message.requestId,
      name: message.name,
    };
  }

  return message;
}

function createToolRequests(pendingCalls: Map<number, PendingToolCall>, reasoning = "") {
  const toolCalls: ModelToolCall[] = [];
  const requests: ReactAgentToolRequest[] = [];
  const ids = new Set<string>();

  for (const [, pending] of [...pendingCalls.entries()].sort(([left], [right]) => left - right)) {
    if (!pending.id) {
      throw new Error("Tool call did not include an id");
    }
    if (!pending.name) {
      throw new Error(`Tool call ${pending.id} did not include a name`);
    }
    if (ids.has(pending.id)) {
      throw new Error(`Duplicate tool call id: ${pending.id}`);
    }
    ids.add(pending.id);

    let input: unknown;
    try {
      input = JSON.parse(pending.arguments);
    } catch {
      throw new Error(`Invalid JSON arguments for tool ${pending.name}`);
    }

    toolCalls.push({
      id: pending.id,
      type: "function",
      function: { name: pending.name, arguments: pending.arguments },
    });
    requests.push({
      id: pending.id,
      name: pending.name,
      rawArguments: pending.arguments,
      input,
    });
  }

  return {
    kind: "toolRequests" as const,
    ...(reasoning ? { reasoning } : {}),
    assistantMessage: { role: "assistant" as const, content: "", ...(reasoning ? { reasoningContent: reasoning } : {}), toolCalls },
    requests,
  };
}
