import type { HostToWebviewMessage } from "../../shared/messages";
import type { MemoryEvidence } from "../memory/types";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type {
  ReactAgentMessage,
  ReactAgentRunOutcome,
  ReactAgentTool,
  ReactAgentToolRequest,
  ReactModelTurn,
} from "./reactTypes";
import { createToolRegistry } from "./toolRegistry";
import { createDefaultReactTools } from "./tools";

const APPLY_EDIT_TOOL_CHOICE = { type: "function", function: { name: "applyEdit" } } as const;
const READ_FILE_TOOL_CHOICE = { type: "function", function: { name: "readFile" } } as const;

export type CreateReactAgentRunnerOptions = {
  modelTurn: ReactModelTurn;
  providerName?: string;
  tools?: ReactAgentTool[];
  maxSteps?: number;
  maxToolRequestsPerStep?: number;
  systemPromptProvider?: (request: AgentRunRequest) => string | Promise<string>;
  /** Optional side-channel invoked exactly once per run, after this run's terminal
   * HostToWebviewMessage would already have been yielded (or the run was cancelled before
   * any was yielded). Never part of the yielded message sequence. */
  recordMemoryRunOutcome?: (outcome: ReactAgentRunOutcome) => void | Promise<void>;
};

export function createReactAgentRunner({
  modelTurn,
  providerName = "ReAct Agent",
  tools = createDefaultReactTools(),
  maxSteps = 3,
  maxToolRequestsPerStep = 10,
  systemPromptProvider,
  recordMemoryRunOutcome,
}: CreateReactAgentRunnerOptions): AgentRunner {
  const toolRegistry = createToolRegistry(tools);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const canApplyEdits = toolsByName.has("applyEdit");
  const canReadFiles = toolsByName.has("readFile");

  return {
    async *run(request) {
      const { runId, task, mode, signal } = request;
      // Defaults to "cancelled": every early return below (pre-run abort, mid-loop abort
      // checks) leaves this untouched, so the finally block classifies them correctly
      // without each call site having to set it explicitly.
      let status: ReactAgentRunOutcome["status"] = "cancelled";
      let finalContent: string | undefined;
      const evidence: MemoryEvidence[] = [];

      try {
        if (signal.aborted) {
          return;
        }

        yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
        yield { type: "assistantStarted", runId, provider: providerName } satisfies HostToWebviewMessage;

        const messages: ReactAgentMessage[] = [];
        const systemPrompt = await resolveSystemPrompt(systemPromptProvider, request);

        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }

        messages.push({ role: "user", content: task });
        const initialMessages = [...messages];
        const editMode = mode === "edit" && canApplyEdits;
        let fileReadForEdit = !canReadFiles;
        let editReviewRequested = false;
        let lastEditObservation = "";

        for (let step = 1; step <= maxSteps + 1; step++) {
          const isFinalAnswerStep = step > maxSteps;
          if (signal.aborted) {
            return;
          }

          yield { type: "assistantThinking", runId, message: `Planning step ${step}` } satisfies HostToWebviewMessage;

          const toolChoice =
            editMode && !editReviewRequested
              ? !fileReadForEdit && step < maxSteps
                ? READ_FILE_TOOL_CHOICE
                : step >= maxSteps
                ? APPLY_EDIT_TOOL_CHOICE
                : "required"
              : isFinalAnswerStep || editReviewRequested
                ? "none"
                : "auto";
          const turnMessages = editReviewRequested
            ? [
                ...initialMessages,
                {
                  role: "user" as const,
                  content: `编辑审阅结果：${lastEditObservation}\n请用中文思考，并用与原始任务相同的语言简洁汇报最终结果。`,
                },
              ]
            : messages;
          const result = await modelTurn({
            messages: turnMessages,
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
            if (editMode && !editReviewRequested) {
              throw new Error("Edit mode cannot finish before applyEdit opens the review interface");
            }
            yield { type: "assistantDelta", runId, content: result.content } satisfies HostToWebviewMessage;
            yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
            status = "completed";
            finalContent = result.content;
            return;
          }

          if (isFinalAnswerStep && !(editMode && !editReviewRequested)) {
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

            const invoke = async (toolRequest: ReactAgentToolRequest) => {
              if (!toolsByName.has(toolRequest.name)) {
                throw new Error(`Unknown tool: ${toolRequest.name}`);
              }
              if (toolRequest.parseError) {
                return { content: `Tool error: ${toolRequest.parseError}`, succeeded: false, evidence: [] as MemoryEvidence[] };
              }
              try {
                const result = await toolRegistry.invoke(toolRequest, signal);
                return { content: result.content, succeeded: true, evidence: result.evidence };
              } catch (error) {
                return { content: `Tool error: ${formatRunError(error)}`, succeeded: false, evidence: [] as MemoryEvidence[] };
              }
            };
            const outcomes = batch.concurrent
              ? await Promise.all(batch.requests.map(({ request }) => invoke(request)))
              : [await invoke(batch.requests[0]!.request)];

            if (signal.aborted) {
              return;
            }

            for (const [index, { request, call }] of batch.requests.entries()) {
              const outcome = outcomes[index]!;
              const content = outcome.content;
              if (request.name === "exploreCode") {
                yield {
                  type: "agentEvent",
                  runId,
                  message: `Tool exploreCode returned (step ${step}, call ${call}): ${content.length} chars`,
                } satisfies HostToWebviewMessage;
              }
              if (!outcome.succeeded) {
                if (request.name === "applyEdit") lastEditObservation = content;
                yield {
                  type: "agentEvent",
                  runId,
                  message: `Tool ${request.name} failed (step ${step}, call ${call}): ${content}`,
                } satisfies HostToWebviewMessage;
              } else {
                evidence.push(...outcome.evidence);
                if (request.name === "applyEdit") {
                  editReviewRequested = true;
                  lastEditObservation = content;
                } else if (request.name === "readFile") {
                  fileReadForEdit = true;
                }
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

        if (editMode && editReviewRequested) {
          yield { type: "assistantDelta", runId, content: lastEditObservation } satisfies HostToWebviewMessage;
          yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
          status = "completed";
          finalContent = lastEditObservation;
          return;
        }

        throw new Error(editMode ? lastEditObservation || "Edit review was not opened" : "Model did not produce a final answer");

      } catch (error) {
        if (signal.aborted) {
          return;
        }

        status = "failed";
        yield { type: "runFailed", runId, message: formatRunError(error) } satisfies HostToWebviewMessage;
      } finally {
        if (recordMemoryRunOutcome) {
          try {
            await recordMemoryRunOutcome({ runId, task, status, finalContent, evidence });
          } catch {
            // Best-effort persistence side-channel: a failure here must never surface as a
            // run failure or change the already-yielded HostToWebviewMessage sequence.
          }
        }
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
