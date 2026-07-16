import type { HostToWebviewMessage } from "../../shared/messages";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { ReactAgentMessage, ReactAgentTool, ReactAgentToolRequest, ReactModelTurn } from "./reactTypes";
import { MAX_EXPLORE_CODE_QUERY_LENGTH } from "./exploreCodeTool";
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

        for (let step = 1; step <= maxSteps + 1; step++) {
          const isFinalAnswerStep = step > maxSteps;
          if (signal.aborted) {
            return;
          }

          yield { type: "assistantThinking", runId, message: `Planning step ${step}` } satisfies HostToWebviewMessage;

          const result = await modelTurn({
            messages,
            signal,
            toolChoice: isFinalAnswerStep ? "none" : "auto",
          });

          if (signal.aborted) {
            return;
          }

          if (result.kind === "final") {
            yield { type: "assistantDelta", runId, content: result.content } satisfies HostToWebviewMessage;
            yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
            return;
          }

          if (isFinalAnswerStep) {
            throw new Error("Model requested tools during the final answer step");
          }

          const distinctToolRequestCount = new Set(result.requests.map((request) => request.name)).size;
          if (distinctToolRequestCount > maxToolRequestsPerStep) {
            throw new Error(`Too many distinct tool requests in one step: ${distinctToolRequestCount}`);
          }

          messages.push(result.assistantMessage);
          const usedToolNames = new Set<string>();
          const combinedExploreCode = combineExploreCodeRequests(result.requests);

          for (const [requestIndex, request] of result.requests.entries()) {
            if (signal.aborted) {
              return;
            }

            const call = requestIndex + 1;
            if (usedToolNames.has(request.name)) {
              const content = getDuplicateToolObservation(request, combinedExploreCode);
              yield {
                type: "agentEvent",
                runId,
                message:
                  combinedExploreCode && request.name === "exploreCode"
                    ? `Combined duplicate tool exploreCode (step ${step}, call ${call})`
                    : `Skipped duplicate tool ${request.name} (step ${step}, call ${call})`,
              } satisfies HostToWebviewMessage;
              messages.push({ role: "tool", requestId: request.id, name: request.name, content });
              continue;
            }
            usedToolNames.add(request.name);

            const invocationRequest =
              combinedExploreCode?.firstRequestId === request.id
                ? {
                    ...request,
                    rawArguments: JSON.stringify({ query: combinedExploreCode.query }),
                    input: { query: combinedExploreCode.query },
                  }
                : request;

            const requestMessage =
              request.name === "exploreCode"
                ? `Running tool exploreCode (step ${step}, call ${call}): ${getExploreCodeQueryPreview(invocationRequest.input)}`
                : `Running tool ${request.name}`;
            yield { type: "agentEvent", runId, message: requestMessage } satisfies HostToWebviewMessage;

            const content = await toolRegistry.invoke(invocationRequest, signal);
            const observation =
              combinedExploreCode?.firstRequestId === request.id
                ? `Combined ${combinedExploreCode.queries.length} exploreCode queries for this step.\n\n${content}`
                : content;

            if (signal.aborted) {
              return;
            }

            if (request.name === "exploreCode") {
              yield {
                type: "agentEvent",
                runId,
                message: `Tool exploreCode returned (step ${step}, call ${call}): ${observation.length} chars`,
              } satisfies HostToWebviewMessage;
            }

            messages.push({
              role: "tool",
              requestId: request.id,
              name: request.name,
              content: observation,
            });
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

type CombinedExploreCodeRequests = {
  firstRequestId: string;
  queries: string[];
  query: string;
};

function combineExploreCodeRequests(
  requests: ReactAgentToolRequest[],
): CombinedExploreCodeRequests | undefined {
  const exploreCodeRequests = requests.filter((request) => request.name === "exploreCode");
  if (exploreCodeRequests.length < 2) {
    return undefined;
  }

  const queries: string[] = [];
  for (const request of exploreCodeRequests) {
    const query = getExploreCodeQuery(request.input);
    if (query === undefined) {
      return undefined;
    }
    queries.push(query);
  }

  const uniqueQueries = [...new Set(queries)];
  if (uniqueQueries.length < 2) {
    return undefined;
  }

  const query = uniqueQueries.join("\n");
  if (query.length > MAX_EXPLORE_CODE_QUERY_LENGTH) {
    return undefined;
  }

  return {
    firstRequestId: exploreCodeRequests[0]!.id,
    queries: uniqueQueries,
    query,
  };
}

function getExploreCodeQuery(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const query = (input as Record<string, unknown>).query;
  if (typeof query !== "string") {
    return undefined;
  }

  const normalized = query.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getDuplicateToolObservation(
  request: ReactAgentToolRequest,
  combinedExploreCode: CombinedExploreCodeRequests | undefined,
): string {
  if (combinedExploreCode && request.name === "exploreCode") {
    return `Tool exploreCode query was combined into request ${combinedExploreCode.firstRequestId} for this step. Review the combined observation before requesting it again in a later step.`;
  }

  return `Tool ${request.name} was skipped because each tool can run only once per step. Review the earlier observation before requesting it again in a later step.`;
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
