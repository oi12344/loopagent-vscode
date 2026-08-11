import { randomUUID } from "node:crypto";
import type { ModelMessage, ModelProvider, ModelToolCall } from "../model/types";
import {
  ReactModelToolChoiceError,
  type ReactAgentMessage,
  type ReactAgentTool,
  type ReactAgentToolRequest,
  type ReactModelTurn,
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
  return async ({ messages, signal, toolChoice = "auto", onReasoningDelta }) => {
    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    const pendingCalls = new Map<number, PendingToolCall>();

    // 当 toolChoice 强制某个具体函数时，只暴露该函数：部分模型（如 DeepSeek）不严格遵守
    // tool_choice 的具体函数约束，会改调其它可用工具。仅保留目标工具可确保它一定被调用。
    const forcedToolName = typeof toolChoice === "object" ? toolChoice.function.name : undefined;
    const activeTools = toolChoice === "none"
      ? []
      : forcedToolName
        ? tools.filter((tool) => tool.name === forcedToolName)
        : tools;

    for await (const event of provider.stream({
      messages: messages.map(toModelMessage),
      signal,
      ...(activeTools.length > 0 ? {
        tools: activeTools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      } : {}),
      toolChoice,
    })) {
      if (event.type === "reasoningDelta") {
        reasoning += event.content;
        onReasoningDelta?.(event.content);
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
      if (toolChoice === "none") {
        throw new ReactModelToolChoiceError();
      }
      if (finishReason !== "tool_calls") {
        throw new Error(`Unexpected finish reason for tool calls: ${finishReason ?? "missing"}`);
      }

      return createToolRequests(pendingCalls, reasoning);
    }

    if (finishReason === "tool_calls") {
      throw new Error("Model finished with tool_calls but returned no tool calls");
    }

    const dsmlCalls = parseDsmlToolCalls(content);
    if (dsmlCalls) {
      if (toolChoice === "none") {
        throw new ReactModelToolChoiceError();
      }
      return createToolRequests(dsmlCalls, reasoning);
    }

    if (content.length > 0) {
      if (toolChoice === "required" || typeof toolChoice === "object") {
        throw new Error("Model did not call a required tool");
      }
      return { kind: "final", content, ...(reasoning ? { reasoning } : {}) };
    }

    throw new Error("Model response was empty");
  };
}

function parseDsmlToolCalls(content: string): Map<number, PendingToolCall> | undefined {
  if (!content.includes("<｜｜DSML｜｜tool_calls>")) return undefined;

  const calls = new Map<number, PendingToolCall>();
  const invokePattern = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  for (const [index, match] of [...content.matchAll(invokePattern)].entries()) {
    const input: Record<string, unknown> = {};
    const parameterPattern = /<｜｜DSML｜｜parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    for (const parameter of match[2].matchAll(parameterPattern)) {
      const value = parameter[3].trim();
      input[parameter[1]] = parameter[2] === "true" ? value : JSON.parse(value);
    }
    calls.set(index, {
      id: `dsml_${randomUUID()}`,
      name: match[1],
      arguments: JSON.stringify(input),
    });
  }

  if (calls.size === 0) throw new Error("Model returned malformed DSML tool calls");
  return calls;
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
    let parseError: string | undefined;
    try {
      input = JSON.parse(pending.arguments);
    } catch {
      parseError = `Invalid JSON arguments for tool ${pending.name}`;
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
      ...(parseError ? { parseError } : {}),
    });
  }

  return {
    kind: "toolRequests" as const,
    ...(reasoning ? { reasoning } : {}),
    assistantMessage: { role: "assistant" as const, content: "", ...(reasoning ? { reasoningContent: reasoning } : {}), toolCalls },
    requests,
  };
}
