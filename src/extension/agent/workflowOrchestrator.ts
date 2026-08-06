import type { HostToWebviewMessage } from "../../shared/messages";
import { createSubagentContext, type SubagentContext, type SubagentContextSnapshot } from "./subagentContext";
import type { ReactAgentTool, ReactAgentToolRequest, ReactAgentToolResult } from "./reactTypes";
import { invokeRegisteredTool, type ToolInvoker } from "./toolRegistry";
import { validateDAG } from "./workflow/dagValidator";
import { resolveRole } from "./workflow/roleRegistry";
import { selectTools } from "./workflow/toolRouter";
import { evaluateSubagentProgress } from "./workflow/subagentProgress";
import { determineVerificationStatus } from "./workflow/verificationDetector";
import { evaluateTimeoutAdjustment } from "./workflow/adaptiveTimeout";
import { extractExplorerFindings, cacheExplorerFindings } from "./workflow/explorerCache";
import type { CreateSubagentConfig, SubagentResult, SubagentRoleId, SubagentRunnerFactory, SubagentStatus, WorkflowLimits } from "./workflow/types";
import type { WorkflowDiagnosticLog } from "../../shared/workflowDiagnostics";
import type { ProjectMemory } from "../memory/projectMemory";
import type { ReactAgentRunOutcome } from "../memory/types";

export type WorkflowEvent =
  | { type: "SubagentCreated"; subagentId: string; task: string; role: SubagentRoleId; dependsOn: readonly string[] }
  | { type: "SubagentStatusChanged"; subagentId: string; status: SubagentStatus }
  | { type: "SubagentMessage"; subagentId: string; message: HostToWebviewMessage };

export type WorkflowEventListener = (event: WorkflowEvent) => void;

export type WorkflowOrchestratorOptions = {
  createRunner: SubagentRunnerFactory;
  limits?: Partial<WorkflowLimits>;
  signal?: AbortSignal;
  /**
   * Best-effort outcome recording for subagent runs. Subagents themselves never get memory
   * tools or read/write access -- the orchestrator records on their behalf at settle() time,
   * the same way the main run's outcome is recorded in providerRegistry.ts. See the 2026-07-24
   * spec's revised isolation clause.
   */
  projectMemory?: ProjectMemory;
};

export type WorkflowOrchestrator = {
  createSubagent(config: CreateSubagentConfig, availableTools: readonly ReactAgentTool[]): string;
  waitForSubagents(ids: readonly string[]): Promise<ReadonlyMap<string, SubagentResult>>;
  getSubagent(id: string): SubagentContextSnapshot | undefined;
  cancelSubagent(id: string): boolean;
  cancelAll(): void;
  invokeTool(tools: readonly ReactAgentTool[], request: ReactAgentToolRequest, signal: AbortSignal): Promise<ReactAgentToolResult>;
  onEvent(listener: WorkflowEventListener): () => void;
};

const DEFAULT_LIMITS: WorkflowLimits = {
  maxSubagentsPerRun: 50,
  maxNestingDepth: 3,
  maxConcurrentSubagents: 10,
  subagentTimeoutMs: 60_000,
  // 60s 装不下 executor 的完整流程（定位 → 读文件 → 改代码 → 跑验证，每步一次模型往返，
  // runCommand 自己还有 30s 默认超时）。给到 5 轮观察窗，只在真的有推进时才用得上。
  maxSubagentTimeoutMs: 300_000,
};

type SubagentEntry = {
  context: SubagentContext;
  /** 进度检查间隔，不是死线。 */
  timeoutMs: number;
  /** 绝对上限，推进判定的延长不得越过。 */
  maxTimeoutMs: number;
  messages: HostToWebviewMessage[];
  result: Promise<SubagentResult>;
  resolveResult: (result: SubagentResult) => void;
  controller?: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  expectedGeneration?: number;
};

const MAX_DIAGNOSTIC_LOG_ENTRIES = 24;
const MAX_DIAGNOSTIC_LOG_CHARS = 800;
const MAX_DIAGNOSTIC_TOTAL_CHARS = 8_000;

export function summarizeSubagentMessages(messages: readonly HostToWebviewMessage[]): WorkflowDiagnosticLog[] {
  const logs: WorkflowDiagnosticLog[] = [];
  let totalChars = 0;

  const append = (log: WorkflowDiagnosticLog): void => {
    if (logs.length >= MAX_DIAGNOSTIC_LOG_ENTRIES || totalChars >= MAX_DIAGNOSTIC_TOTAL_CHARS) return;
    const message = redactDiagnosticText(log.message).slice(0, MAX_DIAGNOSTIC_LOG_CHARS);
    if (!message) return;
    const bounded = { ...log, message };
    const remaining = MAX_DIAGNOSTIC_TOTAL_CHARS - totalChars;
    if (remaining <= 0) return;
    bounded.message = bounded.message.slice(0, remaining);
    logs.push(bounded);
    totalChars += bounded.message.length;
  };

  for (const message of messages) {
    switch (message.type) {
      case "assistantThinking":
        append({ kind: "assistant", message: message.message });
        break;
      case "assistantReasoningDelta":
      case "assistantDelta":
        append({ kind: "assistant", message: message.content });
        break;
      case "agentEvent":
        append({ kind: "assistant", message: message.message });
        break;
      case "toolCallStarted":
        append({ kind: "tool", name: message.toolName, message: `input: ${message.input}` });
        break;
      case "toolCallFinished":
        append({ kind: "tool", succeeded: message.succeeded, message: `output: ${message.output}` });
        break;
      case "runFailed":
        append({ kind: "error", message: message.message });
        break;
      default:
        break;
    }
  }

  return logs;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function createWorkflowOrchestrator(options: WorkflowOrchestratorOptions): WorkflowOrchestrator {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const entries = new Map<string, SubagentEntry>();
  const graph = new Map<string, Set<string>>();
  const listeners = new Set<WorkflowEventListener>();
  const running = new Set<string>();
  const activeToolControllers = new Set<AbortController>();
  let nextId = 1;
  let cancellingAll = false;

  function invokeTool(
    tools: readonly ReactAgentTool[],
    request: ReactAgentToolRequest,
    signal: AbortSignal,
  ): Promise<ReactAgentToolResult> {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
    activeToolControllers.add(controller);

    const call = invokeRegisteredTool(tools, request, controller.signal);
    const cleanup = (): void => {
      activeToolControllers.delete(controller);
      signal.removeEventListener("abort", abortFromCaller);
    };
    void call.then(cleanup, cleanup);
    return call;
  }

  function emit(event: WorkflowEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }

  function settle(entry: SubagentEntry, result: SubagentResult): void {
    const snapshot = entry.context.snapshot();
    if (isTerminal(snapshot.status)) return;

    if (entry.timeout) clearTimeout(entry.timeout);
    const diagnosticLog = result.status === "failed" ? summarizeSubagentMessages(entry.messages) : undefined;

    // 检测验证状态
    const verification = determineVerificationStatus(snapshot.role, entry.messages, result.status);

    const settledResult: SubagentResult = {
      ...result,
      ...(diagnosticLog && diagnosticLog.length > 0 ? { diagnosticLog } : {}),
      verificationStatus: verification.verificationStatus,
      verificationDetails: verification.verificationDetails,
    };

    entry.context.finish(settledResult);
    entry.resolveResult(settledResult);
    emit({ type: "SubagentStatusChanged", subagentId: snapshot.id, status: result.status });

    if (result.status !== "completed") cancelPendingDependents(snapshot.id);

    recordSubagentOutcome(snapshot, settledResult, entry.expectedGeneration);
  }

  function recordSubagentOutcome(
    snapshot: SubagentContextSnapshot,
    result: SubagentResult,
    expectedGeneration: number | undefined,
  ): void {
    if (!options.projectMemory || expectedGeneration === undefined) return;
    // Cancelled runs (timeout, user cancel, cascade from a failed dependency) never reflect
    // the subagent's own work product -- nothing useful to record.
    if (result.status === "cancelled") return;

    const outcome: ReactAgentRunOutcome = {
      runId: snapshot.id,
      task: snapshot.task,
      status: result.status,
      ...(result.content !== undefined ? { finalContent: result.content } : {}),
      evidence: [],
    };
    void options.projectMemory.recordOutcome(outcome, expectedGeneration);

    // 如果是 explorer 角色且成功完成，缓存探索发现
    if (snapshot.role === "explorer" && result.status === "completed") {
      const entry = entries.get(snapshot.id);
      if (entry) {
        const findings = extractExplorerFindings(entry.messages, result.content);
        void cacheExplorerFindings(options.projectMemory, snapshot.task, findings, expectedGeneration);
      }
    }
  }

  function cancelPendingDependents(dependencyId: string): void {
    for (const entry of entries.values()) {
      const snapshot = entry.context.snapshot();
      if (snapshot.status !== "pending" || !snapshot.dependsOn.includes(dependencyId)) continue;
      settle(entry, {
        status: "cancelled",
        error: `Dependency ${dependencyId} did not complete successfully`,
      });
    }
  }

  function schedule(): void {
    if (cancellingAll || options.signal?.aborted) return;

    while (running.size < limits.maxConcurrentSubagents) {
	  const hasRunningExecutor = [...running].some((id) => entries.get(id)?.context.snapshot().role === "executor");
      const ready = [...entries.values()].find((entry) => {
        const snapshot = entry.context.snapshot();
		return snapshot.status === "pending"
		  && !(snapshot.role === "executor" && hasRunningExecutor)
		  && snapshot.dependsOn.every((id) => entries.get(id)?.context.snapshot().status === "completed");
      });
      if (!ready) return;
      void start(ready);
    }
  }

  async function start(entry: SubagentEntry): Promise<void> {
    const snapshot = entry.context.snapshot();
    entry.context.start();
    running.add(snapshot.id);
    const controller = new AbortController();
    entry.controller = controller;

    try {
      emit({ type: "SubagentStatusChanged", subagentId: snapshot.id, status: "running" });
      if (controller.signal.aborted || entry.context.snapshot().status !== "running") return;
      // 进度判定取代硬性死线。每隔 timeoutMs 看一次日志：有推进就再等一轮，卡住或打转
      // 就立刻停止。名义时长用轮次乘间隔而不是实测墙钟，文案才是确定的。
      let checkCount = 0;
      let lastMessageCount = 0;
      let currentTimeoutMs = entry.timeoutMs;
      const scheduleProgressCheck = (): void => {
        entry.timeout = setTimeout(() => {
          if (controller.signal.aborted || entry.context.snapshot().status !== "running") return;
          checkCount++;
          const nominalElapsedMs = checkCount * entry.timeoutMs;
          const verdict = evaluateSubagentProgress(entry.messages, lastMessageCount);
          lastMessageCount = entry.messages.length;

          if (verdict.state === "progressing" || verdict.state === "blocked") {
            // 使用自适应超时评估是否需要调整超时时长
            const adjustment = evaluateTimeoutAdjustment(entry.messages);
            const adjustedTimeout = Math.floor(entry.timeoutMs * adjustment.suggestedMultiplier);
            currentTimeoutMs = Math.min(adjustedTimeout, entry.maxTimeoutMs - nominalElapsedMs);

            if (nominalElapsedMs + currentTimeoutMs <= entry.maxTimeoutMs) {
              emit({
                type: "SubagentMessage",
                subagentId: snapshot.id,
                message: {
                  type: "agentEvent",
                  runId: snapshot.id,
                  message: `progress check at ${nominalElapsedMs}ms: ${verdict.state} (${verdict.reason}). Timeout adjustment: ${adjustment.reason}`,
                },
              });
              scheduleProgressCheck();
              return;
            }
            controller.abort();
            settle(entry, {
              status: "failed",
              error: `Subagent timed out after ${nominalElapsedMs}ms: reached the ${entry.maxTimeoutMs}ms limit while still ${verdict.state}`,
            });
            return;
          }

          controller.abort();
          // stalled 保留原文案：什么都没发生就是超时，分类为 transient 后可重试。
          // looping 用不含 "timed out" 的文案，好让分类器给出 planning——重试一个
          // 打转的节点只会再打转一次，得改任务而不是重跑。
          settle(entry, {
            status: "failed",
            error: verdict.state === "looping"
              ? `Subagent stopped making progress after ${nominalElapsedMs}ms: ${verdict.reason}`
              : `Subagent timed out after ${nominalElapsedMs}ms`,
          });
        }, entry.timeoutMs);
      };
      scheduleProgressCheck();
      const runner = await options.createRunner({
        subagentId: snapshot.id,
        task: snapshot.task,
        role: snapshot.role,
        signal: controller.signal,
        tools: snapshot.tools,
        invokeTool: ((request, signal) => invokeTool(snapshot.tools, request, signal)) satisfies ToolInvoker,
      });
      if (controller.signal.aborted || entry.context.snapshot().status !== "running") return;
      let failure: string | undefined;
      for await (const message of runner.run({ runId: snapshot.id, task: snapshot.task, signal: controller.signal })) {
        if (controller.signal.aborted) break;
        const savedMessage = structuredClone(message);
        entry.messages.push(savedMessage);
        emit({ type: "SubagentMessage", subagentId: snapshot.id, message: structuredClone(savedMessage) });
        if (message.type === "runFailed") {
          failure = message.message;
          break;
        }
      }

      if (failure) {
        controller.abort();
        settle(entry, { status: "failed", error: failure });
        return;
      }
      if (entry.context.snapshot().status !== "running") return;

      const content = entry.messages
        .filter((message): message is Extract<HostToWebviewMessage, { type: "assistantDelta" }> => message.type === "assistantDelta")
        .map((message) => message.content)
        .join("");
      settle(entry, { status: "completed", ...(content ? { content } : {}) });
    } catch (error) {
      if (entry.context.snapshot().status === "running") {
        settle(entry, { status: "failed", error: formatError(error) });
      }
    } finally {
      running.delete(snapshot.id);
      if (!cancellingAll) schedule();
    }
  }

  function cancelSubagent(id: string): boolean {
    const entry = entries.get(id);
    if (!entry || isTerminal(entry.context.snapshot().status)) return false;
    entry.controller?.abort();
    settle(entry, { status: "cancelled" });
    return true;
  }

  function cancelAll(): void {
    cancellingAll = true;
    for (const controller of activeToolControllers) controller.abort();
    for (const id of entries.keys()) cancelSubagent(id);
    cancellingAll = false;
  }

  const orchestrator: WorkflowOrchestrator = {
    createSubagent(config, availableTools) {
      if (entries.size >= limits.maxSubagentsPerRun) {
        throw new Error(`Max subagents per run (${limits.maxSubagentsPerRun}) exceeded`);
      }

      const id = `subagent-${nextId}`;
      const dependencies = [...(config.dependsOn ?? [])];
      const nextGraph = new Map(graph);
      nextGraph.set(id, new Set(dependencies));
      const validation = validateDAG(nextGraph, limits);
      if (!validation.valid) throw new Error(validation.error);

      let resolveResult!: (result: SubagentResult) => void;
      const result = new Promise<SubagentResult>((resolve) => {
        resolveResult = resolve;
      });
      const profile = resolveRole(config.role);
      const context = createSubagentContext({
        id,
        task: config.task,
        role: profile.id,
        dependsOn: dependencies,
        tools: selectTools(config.task, availableTools, config.toolHints, profile.allowedTools),
      });
      const entry: SubagentEntry = {
        context,
        // timeoutMs 现在是进度检查间隔，仍取 min 是为了让检查足够频繁；真正的天花板
        // 是 maxTimeoutMs，所以这里的收窄不再意味着"配了大值也白配"。
        timeoutMs: Math.min(config.timeoutMs ?? limits.subagentTimeoutMs, limits.subagentTimeoutMs),
        maxTimeoutMs: Math.max(
          limits.maxSubagentTimeoutMs,
          Math.min(config.timeoutMs ?? limits.subagentTimeoutMs, limits.subagentTimeoutMs),
        ),
        messages: [],
        result,
        resolveResult,
        expectedGeneration: options.projectMemory?.getGeneration(),
      };

      nextId += 1;
      graph.set(id, new Set(dependencies));
      entries.set(id, entry);
      emit({ type: "SubagentCreated", subagentId: id, task: config.task, role: profile.id, dependsOn: dependencies });
      if (options.signal?.aborted) cancelSubagent(id);
      else schedule();
      return id;
    },

    async waitForSubagents(ids) {
      const requested = ids.map((id) => {
        const entry = entries.get(id);
        if (!entry) throw new Error(`Subagent ${id} not found`);
        return [id, entry.result] as const;
      });
      const results = await Promise.all(requested.map(async ([id, result]) => [id, await result] as const));
      return new Map(results);
    },

    getSubagent(id) {
      return entries.get(id)?.context.snapshot();
    },

    cancelSubagent,
    cancelAll,
    invokeTool,

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  options.signal?.addEventListener("abort", cancelAll, { once: true });
  return orchestrator;
}

function isTerminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Subagent run failed";
}
