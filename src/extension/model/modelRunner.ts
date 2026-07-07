import type { AgentRunner } from "../agentRunner";
import type { HostToWebviewMessage } from "../../shared/messages";
import type { ModelMessage, ModelProvider } from "./types";

export type CreateModelRunnerOptions = {
  provider: ModelProvider;
  systemPrompt?: string;
};

export function createModelRunner({ provider, systemPrompt }: CreateModelRunnerOptions): AgentRunner {
  return {
    run: async function* ({ runId, task, signal }) {
      yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
      yield { type: "assistantStarted", runId, provider: provider.displayName } satisfies HostToWebviewMessage;
      yield { type: "assistantThinking", runId, message: `Calling ${provider.displayName}` } satisfies HostToWebviewMessage;

      const messages = createMessages(task, systemPrompt);
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
          yield { type: "assistantDelta", runId, content: event.content } satisfies HostToWebviewMessage;
        }
      }

      yield { type: "assistantFinished", runId } satisfies HostToWebviewMessage;
      yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
    },
  };
}

function createMessages(task: string, systemPrompt?: string): ModelMessage[] {
  const messages: ModelMessage[] = [];

  if (systemPrompt?.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }

  messages.push({ role: "user", content: task });
  return messages;
}
