import type { HostToWebviewMessage } from "../../shared/messages";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { ReactAgentMessage, ReactAgentTool, ReactModelTurn } from "./reactTypes";
import { createToolRegistry } from "./toolRegistry";
import { createDefaultReactTools } from "./tools";

export type CreateReactAgentRunnerOptions = {
  modelTurn: ReactModelTurn;
  providerName?: string;
  tools?: ReactAgentTool[];
  maxSteps?: number;
  maxToolRequestsPerStep?: number;
  systemPromptProvider?: (request: AgentRunRequest) => string | Promise<string>;
};

export function createReactAgentRunner({
  modelTurn,
  providerName = "ReAct Agent",
  tools = createDefaultReactTools(),
  maxSteps = 4,
  maxToolRequestsPerStep = 3,
  systemPromptProvider,
}: CreateReactAgentRunnerOptions): AgentRunner {
  const toolRegistry = createToolRegistry(tools);

  return {
    async *run(request) {
      const { runId, task, signal } = request;
      if (signal.aborted) {
        return;
      }

      try {
        yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
        yield { type: "assistantStarted", runId, provider: providerName } satisfies HostToWebviewMessage;

        const messages: ReactAgentMessage[] = [];
        const systemPrompt = await resolveSystemPrompt(systemPromptProvider, request);

        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }

        messages.push({ role: "user", content: task });

        for (let step = 1; step <= maxSteps; step++) {
          if (signal.aborted) {
            return;
          }

          yield { type: "assistantThinking", runId, message: `Planning step ${step}` } satisfies HostToWebviewMessage;

          const result = await modelTurn({ messages, signal });

          if (signal.aborted) {
            return;
          }

          if (result.kind === "final") {
            yield { type: "assistantDelta", runId, content: result.content } satisfies HostToWebviewMessage;
            yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
            return;
          }

          if (result.requests.length > maxToolRequestsPerStep) {
            throw new Error(`Too many tool requests in one step: ${result.requests.length}`);
          }

          messages.push(result.assistantMessage);

          for (const request of result.requests) {
            if (signal.aborted) {
              return;
            }

            yield { type: "agentEvent", runId, message: `Running tool ${request.name}` } satisfies HostToWebviewMessage;

            const content = await toolRegistry.invoke(request, signal);

            if (signal.aborted) {
              return;
            }

            messages.push({
              role: "tool",
              requestId: request.id,
              name: request.name,
              content,
            });
          }
        }

        yield { type: "runFailed", runId, message: `Reached max ReAct steps: ${maxSteps}` } satisfies HostToWebviewMessage;
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        yield { type: "runFailed", runId, message: formatRunError(error) } satisfies HostToWebviewMessage;
      }
    },
  };
}

async function resolveSystemPrompt(
  provider: CreateReactAgentRunnerOptions["systemPromptProvider"],
  request: AgentRunRequest,
): Promise<string | undefined> {
  if (!provider) {
    return undefined;
  }

  try {
    const prompt = await provider(request);
    return prompt.trim().length > 0 ? prompt : undefined;
  } catch {
    return undefined;
  }
}

function formatRunError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "ReAct agent run failed";
}
