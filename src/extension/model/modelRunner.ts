import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { HostToWebviewMessage } from "../../shared/messages";
import type { ModelMessage, ModelProvider } from "./types";

export type CreateModelRunnerOptions = {
  provider: ModelProvider;
  systemPrompt?: string;
  systemPromptProvider?: (request: AgentRunRequest) => string | Promise<string>;
};

export function createModelRunner({ provider, systemPrompt, systemPromptProvider }: CreateModelRunnerOptions): AgentRunner {
  return {
    run: async function* (request) {
      const { runId, task, signal } = request;
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

      const messages = createMessages(task, systemPrompts);
      let reportedReasoningSignal = false;

      for await (const event of provider.stream({ messages, signal })) {
        if (signal.aborted) {
          return;
        }

        if (event.type === "reasoningDelta" && !reportedReasoningSignal) {
          reportedReasoningSignal = true;
          yield {
            type: "assistantThinking",
            runId,
            message: "Received model reasoning signal",
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

function createMessages(task: string, systemPrompts: Array<string | undefined>): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const systemPrompt of systemPrompts) {
    const trimmedPrompt = systemPrompt?.trim();

    if (trimmedPrompt) {
      messages.push({ role: "system", content: trimmedPrompt });
    }
  }

  messages.push({ role: "user", content: task });

  return messages;
}
