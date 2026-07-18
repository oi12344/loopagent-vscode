import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { HostToWebviewMessage } from "../../shared/messages";
import type { ModelMessage, ModelProvider } from "./types";
import { formatConversationContext } from "./conversationContextFormatter";
import type { FormattedContext } from "./conversationContextFormatter";

export type CreateModelRunnerOptions = {
  provider: ModelProvider;
  systemPrompt?: string;
  systemPromptProvider?: (request: AgentRunRequest) => string | Promise<string>;
};

export function createModelRunner({ provider, systemPrompt, systemPromptProvider }: CreateModelRunnerOptions): AgentRunner {
  return {
    run: async function* (request) {
      const { runId, task, signal, conversationHistory = [] } = request;
      yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
      yield { type: "assistantStarted", runId, provider: provider.displayName } satisfies HostToWebviewMessage;

      const systemPrompts = [systemPrompt];
      if (systemPromptProvider) {
        yield {
          type: "assistantThinking",
          runId,
          message: "Building code context",
        } satisfies HostToWebviewMessage;

        try {
          systemPrompts.push(await systemPromptProvider(request));
        } catch {
          yield {
            type: "assistantThinking",
            runId,
            message: "Code context unavailable",
          } satisfies HostToWebviewMessage;
        }
      }

      yield {
        type: "assistantThinking",
        runId,
        message: `Calling ${provider.displayName}`,
      } satisfies HostToWebviewMessage;

      // 使用 formatConversationContext 处理对话历史和当前任务
      const formattedContext = formatConversationContext(conversationHistory, task);
      const messages = createMessages(formattedContext, systemPrompts);

      for await (const event of provider.stream({ messages, signal })) {
        if (signal.aborted) {
          return;
        }

        if (event.type === "reasoningDelta") {
          yield {
            type: "assistantReasoningDelta",
            runId,
            content: event.content,
          } satisfies HostToWebviewMessage;
        }

        if (event.type === "contentDelta") {
          yield {
            type: "assistantDelta",
            runId,
            content: event.content,
          } satisfies HostToWebviewMessage;
        }
      }

      yield { type: "assistantFinished", runId } satisfies HostToWebviewMessage;
      yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
    },
  };
}

function createMessages(
  formattedContext: FormattedContext,
  systemPrompts: Array<string | undefined>,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const systemPrompt of systemPrompts) {
    const trimmedPrompt = systemPrompt?.trim();

    if (trimmedPrompt) {
      messages.push({ role: "system", content: trimmedPrompt });
    }
  }

  // 添加格式化的上下文 systemPrompt
  const trimmedContextPrompt = formattedContext.systemPrompt?.trim();
  if (trimmedContextPrompt) {
    messages.push({ role: "system", content: trimmedContextPrompt });
  }

  // 添加消息历史
  messages.push(...formattedContext.messageHistory);

  return messages;
}
