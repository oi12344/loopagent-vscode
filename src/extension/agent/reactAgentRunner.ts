import type { HostToWebviewMessage } from "../../shared/messages";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { ReactAgentMessage, ReactAgentTool, ReactAgentToolRequest, ReactModelTurn } from "./reactTypes";
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
  maxSteps = 3,
  maxToolRequestsPerStep = 10,
  systemPromptProvider,
}: CreateReactAgentRunnerOptions): AgentRunner {
  const toolRegistry = createToolRegistry(tools);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const canApplyEdits = toolsByName.has("applyEdit");

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
        let forceReviewToolCall = false;
        let retriedDeferredEditConfirmation = false;

        for (let step = 1; step <= maxSteps + 1; step++) {
          const isFinalAnswerStep = step > maxSteps;
          if (signal.aborted) {
            return;
          }

          yield { type: "assistantThinking", runId, message: `Planning step ${step}` } satisfies HostToWebviewMessage;

          const toolChoice = isFinalAnswerStep ? "none" : forceReviewToolCall ? "required" : "auto";
          forceReviewToolCall = false;
          const result = await modelTurn({
            messages,
            signal,
            toolChoice,
          });

          if (signal.aborted) {
            return;
          }

          if (result.reasoning) {
            yield { type: "assistantReasoningDelta", runId, content: result.reasoning } satisfies HostToWebviewMessage;
          }

          if (result.kind === "final") {
            if (
              canApplyEdits &&
              !retriedDeferredEditConfirmation &&
              step < maxSteps &&
              isDeferredEditConfirmation(result.content)
            ) {
              retriedDeferredEditConfirmation = true;
              forceReviewToolCall = true;
              continue;
            }
            yield { type: "assistantDelta", runId, content: result.content } satisfies HostToWebviewMessage;
            yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
            return;
          }

          if (isFinalAnswerStep) {
            throw new Error("Model requested tools during the final answer step");
          }

          if (result.requests.length > maxToolRequestsPerStep) {
            throw new Error(`Too many tool requests in one step: ${result.requests.length}`);
          }

          messages.push(result.assistantMessage);
          for (const batch of createToolRequestBatches(result.requests, toolsByName)) {
            for (const { request, call } of batch.requests) {
              if (signal.aborted) {
                return;
              }

              const requestMessage =
                request.name === "exploreCode"
                  ? `Running tool exploreCode (step ${step}, call ${call}): ${getExploreCodeQueryPreview(request.input)}`
                  : `Running tool ${request.name}`;
              yield { type: "agentEvent", runId, message: requestMessage } satisfies HostToWebviewMessage;
            }

            if (signal.aborted) {
              return;
            }

            const contents = batch.concurrent
              ? await Promise.all(batch.requests.map(({ request }) => toolRegistry.invoke(request, signal)))
              : [await toolRegistry.invoke(batch.requests[0]!.request, signal)];

            if (signal.aborted) {
              return;
            }

            for (const [index, { request, call }] of batch.requests.entries()) {
              const content = contents[index]!;
              if (request.name === "exploreCode") {
                yield {
                  type: "agentEvent",
                  runId,
                  message: `Tool exploreCode returned (step ${step}, call ${call}): ${content.length} chars`,
                } satisfies HostToWebviewMessage;
              }

              messages.push({
                role: "tool",
                requestId: request.id,
                name: request.name,
                content,
              });
            }
          }
        }

      } catch (error) {
        if (signal.aborted) {
          return;
        }

        yield { type: "runFailed", runId, message: formatRunError(error) } satisfies HostToWebviewMessage;
      }
    },
  };
}

type ToolRequestBatch = {
  concurrent: boolean;
  requests: Array<{ request: ReactAgentToolRequest; call: number }>;
};

function createToolRequestBatches(
  requests: ReactAgentToolRequest[],
  toolsByName: ReadonlyMap<string, ReactAgentTool>,
): ToolRequestBatch[] {
  const batches: ToolRequestBatch[] = [];

  for (const [index, request] of requests.entries()) {
    const concurrent = isConcurrencySafe(request, toolsByName);
    const previous = batches.at(-1);
    if (concurrent && previous?.concurrent) {
      previous.requests.push({ request, call: index + 1 });
      continue;
    }
    batches.push({ concurrent, requests: [{ request, call: index + 1 }] });
  }

  return batches;
}

function isConcurrencySafe(
  request: ReactAgentToolRequest,
  toolsByName: ReadonlyMap<string, ReactAgentTool>,
): boolean {
  const tool = toolsByName.get(request.name);
  if (!tool?.isConcurrencySafe) {
    return false;
  }

  try {
    return tool.isConcurrencySafe(request.input);
  } catch {
    return false;
  }
}

function getExploreCodeQueryPreview(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "<invalid query>";
  }

  const query = (input as Record<string, unknown>).query;
  if (typeof query !== "string") {
    return "<invalid query>";
  }

  const normalized = query.replace(/\s+/g, " ").trim();
  const containsSensitivePath =
    /[a-z]:[\\/]/i.test(normalized) ||
    /\\\\[^\\\s]+\\[^\\\s]+/.test(normalized) ||
    /(?:^|[^a-z0-9._-])\/\S/i.test(normalized);
  const containsCredential =
    /\b(?:api[_ -]?key|(?:access|refresh|auth)[_ -]?token|secret|token|password|credential)\b\s*[:=]\s*\S+/i.test(
      normalized,
    ) ||
    /\bbearer\s+\S+|\bsk-[a-z0-9_-]{8,}/i.test(normalized);
  if (containsSensitivePath || containsCredential) {
    return "<sensitive query hidden>";
  }
  return normalized.slice(0, 200) || "<empty query>";
}

function isDeferredEditConfirmation(content: string): boolean {
  return (
    /(?:confirm|approve).{0,80}(?:apply|change|edit|modification)/i.test(content) ||
    /(?:请|是否).{0,16}(?:确认|批准).{0,32}(?:应用|执行|修改|变更)/.test(content) ||
    /(?:确认|批准).{0,32}(?:应用|执行).{0,32}(?:修改|变更)/.test(content)
  );
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
