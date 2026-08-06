import type { HostToWebviewMessage } from "../../shared/messages";
import type { InterruptedRunCheckpoint } from "../../shared/chatTypes";
import type { MemoryEvidence } from "../memory/types";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { ReactAgentMessage, ReactAgentRunOutcome, ReactAgentTool, ReactAgentToolRequest, ReactModelTurn } from "./reactTypes";
import { createToolInvoker, type ToolInvoker } from "./toolRegistry";
import { createDefaultReactTools } from "./tools";
import type { ImageAnalysisContext } from "../vision/imageAnalysisService";

const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

export type CreateReactAgentRunnerOptions = {
  modelTurn: ReactModelTurn;
  providerName?: string;
  tools?: ReactAgentTool[];
  maxSteps?: number;
  maxToolRequestsPerStep?: number;
  requiredToolNames?: string[];
  /** 至少一个必须成功调用；与 requiredToolNames（全部满足）语义独立，可同时使用 */
  requiredAnyOfToolNames?: string[];
  systemPromptProvider?: (request: AgentRunRequest, imageAnalyses?: ImageAnalysisContext[]) => string | Promise<string>;
  onCheckpoint?: (checkpoint: InterruptedRunCheckpoint) => void | Promise<void>;
  recordMemoryRunOutcome?: (outcome: ReactAgentRunOutcome) => void | Promise<void>;
  /** 图片分析结果注入函数（由外部 extension.ts 提供） */
  analyzeImages?: (request: AgentRunRequest) => Promise<ImageAnalysisContext[]>;
  invokeTool?: ToolInvoker;
};

export function createReactAgentRunner({
  modelTurn,
  providerName = "ReAct Agent",
  tools = createDefaultReactTools(),
  maxSteps = 20,
  maxToolRequestsPerStep = 10,
  requiredToolNames: configuredRequiredToolNames = [],
  requiredAnyOfToolNames: configuredRequiredAnyOfToolNames = [],
  systemPromptProvider,
  onCheckpoint,
  recordMemoryRunOutcome,
  analyzeImages,
  invokeTool: configuredInvokeTool,
}: CreateReactAgentRunnerOptions): AgentRunner {
  const invokeTool = configuredInvokeTool ?? createToolInvoker(tools);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async *run(request) {
      const { runId, task, signal, conversationHistory = [], resumeState } = request;
      const requiredToolNames = request.requiredToolNames ?? configuredRequiredToolNames;
      const requiredAnyOfToolNames = configuredRequiredAnyOfToolNames;
      let status: ReactAgentRunOutcome["status"] = "cancelled";
      let finalContent: string | undefined;
      const evidence: MemoryEvidence[] = [];
      try {
        if (signal.aborted) {
          return;
        }
        yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
        yield { type: "assistantStarted", runId, provider: providerName } satisfies HostToWebviewMessage;

        const resumedCheckpoint = resumeState?.kind === "react" ? resumeState.checkpoint : undefined;
        const messages: ReactAgentMessage[] = resumedCheckpoint
          ? resumedCheckpoint.messages.map((message) => message as unknown as ReactAgentMessage)
          : (request.initialMessages ?? []).map((message) => ({ ...message }));
        const initialStep = resumedCheckpoint?.step ?? 1;
        const successfulTools = new Set<string>();
        let requiredToolRetries = 0;
        const succeededCalls = new Map<string, string>(); // 签名 → 结果摘要，用于拦截无意义的重复调用
        const toolFailures = new Map<string, number>(); // 工具名 → 连续失败数，用于失败熔断

        if (!resumedCheckpoint) {
          // 分析用户上传的图片（如果有）
          let imageAnalyses: ImageAnalysisContext[] = [];
          if (analyzeImages && request.attachments && request.attachments.length > 0) {
            try {
              yield { type: "assistantThinking", runId, message: "分析上传的图片..." } satisfies HostToWebviewMessage;
              imageAnalyses = await analyzeImages(request);
              console.log(`[ReactAgent] Analyzed ${imageAnalyses.length} image(s)`);
            } catch (error) {
              console.error("[ReactAgent] Image analysis failed:", error);
              // 图片分析失败不应阻塞对话，继续执行
            }
          }

          const systemPrompt = await resolveSystemPrompt(systemPromptProvider, request, imageAnalyses);

          if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
          }

          for (const historyMsg of conversationHistory) {
            messages.push({
              role: historyMsg.role,
              content: historyMsg.content,
              ...(historyMsg.reasoning ? { reasoningContent: historyMsg.reasoning } : {}),
            });
          }

          const latestMessage = messages.at(-1);
          if (latestMessage?.role !== "user" || latestMessage.content !== task) {
            messages.push({ role: "user", content: task });
          }
        }

        const saveCheckpoint = async (step: number): Promise<void> => {
          if (!onCheckpoint) return;
          await onCheckpoint({
            version: 1,
            conversationId: request.conversationId ?? resumedCheckpoint?.conversationId ?? "",
            runId,
            task,
            step,
            messages: messages.map((message) => ({ ...message })),
            updatedAt: Date.now(),
          });
        };

        for (let step = initialStep; step <= maxSteps + 1 + 2; step++) {
          const isFinalAnswerStep = step > maxSteps;
          if (signal.aborted) {
            return;
          }

          yield { type: "assistantThinking", runId, message: `Planning step ${step}` } satisfies HostToWebviewMessage;

          await saveCheckpoint(step);
          if (signal.aborted) {
            return;
          }

          const missingRequirements = getMissingRequirements(requiredToolNames, requiredAnyOfToolNames, successfulTools);
          const toolChoice = isFinalAnswerStep && missingRequirements.length === 0 ? "none" : "auto";
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
            const missingTools = getMissingRequirements(requiredToolNames, requiredAnyOfToolNames, successfulTools);
            if (missingTools.length > 0) {
              if (requiredToolRetries >= 2) {
                throw new Error(`Required tools were not called successfully: ${missingTools.join(", ")}`);
              }
              requiredToolRetries++;
              messages.push({ role: "user", content: `Before finishing, call required tool(s): ${missingTools.join(", ")}.` });
              continue;
            }
            yield { type: "assistantDelta", runId, content: result.content } satisfies HostToWebviewMessage;
            yield { type: "assistantFinished", runId } satisfies HostToWebviewMessage;
            yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
            status = "completed";
            finalContent = result.content;
            return;
          }

          if (isFinalAnswerStep) {
            const missingTools = getMissingRequirements(requiredToolNames, requiredAnyOfToolNames, successfulTools);
            if (missingTools.length === 0) {
              if (result.reasoning) {
                yield { type: "assistantReasoningDelta", runId, content: result.reasoning } satisfies HostToWebviewMessage;
              }
              yield { type: "assistantDelta", runId, content: result.assistantMessage.content } satisfies HostToWebviewMessage;
              yield { type: "assistantFinished", runId } satisfies HostToWebviewMessage;
              yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
              status = "completed";
              finalContent = result.assistantMessage.content;
              return;
            }
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

              yield {
                type: "toolCallStarted",
                runId,
                callId: `${step}-${call}`,
                toolName: request.name,
                input: getToolInputPreview(request.name, request.input),
              } satisfies HostToWebviewMessage;
            }

            if (signal.aborted) {
              return;
            }

            const invoke = async (toolRequest: ReactAgentToolRequest) => {
              if (!toolsByName.has(toolRequest.name)) {
                return { content: `Tool error: Unknown tool "${toolRequest.name}"`, succeeded: false, productive: false, evidence: [] as MemoryEvidence[] };
              }
              if (toolRequest.parseError) {
                return { content: `Tool error: ${toolRequest.parseError}`, succeeded: false, productive: false, evidence: [] as MemoryEvidence[] };
              }
              // ponytail: 同批次并发的相同调用会漏判（记录发生在批次结束后），可接受 —— maxToolRequestsPerStep 封顶
              const cached = succeededCalls.get(`${toolRequest.name}:${toolRequest.rawArguments}`);
              if (cached !== undefined) {
                return {
                  content: `重复调用：已用相同参数调用过 ${toolRequest.name}，上次结果：${cached}。请改变查询或给出最终答案。`,
                  succeeded: false,
                  productive: false,
                  evidence: [] as MemoryEvidence[],
                };
              }
              try {
                const result = await invokeTool(toolRequest, signal);
                return { content: result.content, succeeded: true, productive: result.productive ?? true, evidence: result.evidence };
              } catch (error) {
                return { content: `Tool error: ${formatRunError(error)}`, succeeded: false, productive: false, evidence: [] as MemoryEvidence[] };
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
              // 未命中/空结果的调用不抛错（succeeded 为真），但不计入证据门禁 -- 见 reactTypes.ts 的 productive 说明
              if (outcome.succeeded && outcome.productive) successfulTools.add(request.name);
              yield {
                type: "toolCallFinished",
                runId,
                callId: `${step}-${call}`,
                succeeded: outcome.succeeded,
                output: getToolOutputPreview(content),
              } satisfies HostToWebviewMessage;
              if (outcome.succeeded) {
                succeededCalls.set(`${request.name}:${request.rawArguments}`, content.slice(0, 200));
                toolFailures.set(request.name, 0);
                evidence.push(...outcome.evidence);
              } else {
                const failures = (toolFailures.get(request.name) ?? 0) + 1;
                toolFailures.set(request.name, failures);
                if (failures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
                  throw new Error(`工具 ${request.name} 连续失败 ${failures} 次，终止运行`);
                }
              }

              messages.push({
                role: "tool",
                requestId: request.id,
                name: request.name,
                content,
              });
            }

            await saveCheckpoint(step + 1);
          }
        }

        throw new Error("Model did not produce a final answer");

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
            // Memory persistence is best-effort and must not change the run result.
          }
        }
      }
    },
  };
}

function getMissingRequirements(
  requiredToolNames: string[],
  requiredAnyOfToolNames: string[],
  successfulTools: ReadonlySet<string>,
): string[] {
  const missingAllOf = requiredToolNames.filter((name) => !successfulTools.has(name));
  const anyOfUnmet = requiredAnyOfToolNames.length > 0 && !requiredAnyOfToolNames.some((name) => successfulTools.has(name));
  return anyOfUnmet ? [...missingAllOf, `one of [${requiredAnyOfToolNames.join(", ")}]`] : missingAllOf;
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

const MAX_TOOL_OUTPUT_PREVIEW_LENGTH = 2_000;

function getToolInputPreview(toolName: string, input: unknown): string {
  if (toolName === "exploreCode") {
    return getExploreCodeQueryPreview(input);
  }
  if (toolName === "runCommand") {
    return getRunCommandInputPreview(input);
  }
  return getGenericInputPreview(input);
}

function getToolOutputPreview(content: string): string {
  return content.length > MAX_TOOL_OUTPUT_PREVIEW_LENGTH
    ? `${content.slice(0, MAX_TOOL_OUTPUT_PREVIEW_LENGTH)}\n...(输出已截断)`
    : content;
}

function getRunCommandInputPreview(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "<invalid command>";
  }

  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") {
    return "<invalid command>";
  }

  const cwd = (input as Record<string, unknown>).cwd;
  const normalized = command.trim();
  return typeof cwd === "string" && cwd.trim().length > 0 ? `${normalized} (cwd: ${cwd.trim()})` : normalized;
}

function getGenericInputPreview(input: unknown): string {
  try {
    const serialized = JSON.stringify(input) ?? "<empty input>";
    return serialized.length > 200 ? `${serialized.slice(0, 200)}...` : serialized;
  } catch {
    return "<unserializable input>";
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
  imageAnalyses?: ImageAnalysisContext[],
): Promise<string | undefined> {
  if (!provider) {
    return undefined;
  }

  try {
    const prompt = await provider(request, imageAnalyses);
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
