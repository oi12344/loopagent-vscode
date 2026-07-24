import type { HostToWebviewMessage } from "../../shared/messages";
import { createSubagentContext, type SubagentContext, type SubagentContextSnapshot } from "./subagentContext";
import type { ReactAgentTool } from "./reactTypes";
import { validateDAG } from "./workflow/dagValidator";
import { selectTools } from "./workflow/toolRouter";
import type { CreateSubagentConfig, SubagentResult, SubagentRunnerFactory, SubagentStatus, WorkflowLimits } from "./workflow/types";

export type WorkflowEvent =
  | { type: "SubagentCreated"; subagentId: string; task: string; dependsOn: readonly string[] }
  | { type: "SubagentStatusChanged"; subagentId: string; status: SubagentStatus }
  | { type: "SubagentMessage"; subagentId: string; message: HostToWebviewMessage };

export type WorkflowEventListener = (event: WorkflowEvent) => void;

export type WorkflowOrchestratorOptions = {
  createRunner: SubagentRunnerFactory;
  limits?: Partial<WorkflowLimits>;
  signal?: AbortSignal;
};

export type WorkflowOrchestrator = {
  createSubagent(config: CreateSubagentConfig, availableTools: readonly ReactAgentTool[]): string;
  waitForSubagents(ids: readonly string[]): Promise<ReadonlyMap<string, SubagentResult>>;
  getSubagent(id: string): SubagentContextSnapshot | undefined;
  cancelSubagent(id: string): void;
  cancelAll(): void;
  onEvent(listener: WorkflowEventListener): () => void;
};

const DEFAULT_LIMITS: WorkflowLimits = {
  maxSubagentsPerRun: 50,
  maxNestingDepth: 3,
  maxConcurrentSubagents: 10,
  subagentTimeoutMs: 30_000,
};

type SubagentEntry = {
  context: SubagentContext;
  timeoutMs: number;
  messages: HostToWebviewMessage[];
  result: Promise<SubagentResult>;
  resolveResult: (result: SubagentResult) => void;
  controller?: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
};

export function createWorkflowOrchestrator(options: WorkflowOrchestratorOptions): WorkflowOrchestrator {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const entries = new Map<string, SubagentEntry>();
  const graph = new Map<string, Set<string>>();
  const listeners = new Set<WorkflowEventListener>();
  const running = new Set<string>();
  let nextId = 1;
  let cancellingAll = false;

  function emit(event: WorkflowEvent): void {
    for (const listener of listeners) listener(event);
  }

  function settle(entry: SubagentEntry, result: SubagentResult): void {
    const snapshot = entry.context.snapshot();
    if (isTerminal(snapshot.status)) return;

    if (entry.timeout) clearTimeout(entry.timeout);
    running.delete(snapshot.id);
    entry.context.finish(result);
    entry.resolveResult(result);
    emit({ type: "SubagentStatusChanged", subagentId: snapshot.id, status: result.status });

    if (result.status !== "completed") cancelPendingDependents(snapshot.id);
    if (!cancellingAll) schedule();
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
      const ready = [...entries.values()].find((entry) => {
        const snapshot = entry.context.snapshot();
        return snapshot.status === "pending" && snapshot.dependsOn.every((id) => entries.get(id)?.context.snapshot().status === "completed");
      });
      if (!ready) return;
      void start(ready);
    }
  }

  async function start(entry: SubagentEntry): Promise<void> {
    const snapshot = entry.context.snapshot();
    entry.context.start();
    running.add(snapshot.id);
    emit({ type: "SubagentStatusChanged", subagentId: snapshot.id, status: "running" });

    const controller = new AbortController();
    entry.controller = controller;
    entry.timeout = setTimeout(() => {
      controller.abort();
      settle(entry, { status: "failed", error: `Subagent timed out after ${entry.timeoutMs}ms` });
    }, entry.timeoutMs);

    try {
      const runner = await options.createRunner({
        subagentId: snapshot.id,
        task: snapshot.task,
        signal: controller.signal,
        tools: snapshot.tools,
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
    }
  }

  function cancelSubagent(id: string): void {
    const entry = entries.get(id);
    if (!entry || isTerminal(entry.context.snapshot().status)) return;
    entry.controller?.abort();
    settle(entry, { status: "cancelled" });
  }

  function cancelAll(): void {
    cancellingAll = true;
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
      const context = createSubagentContext({
        id,
        task: config.task,
        dependsOn: dependencies,
        tools: selectTools(config.task, availableTools, config.toolHints),
      });
      const entry: SubagentEntry = {
        context,
        timeoutMs: config.timeoutMs ?? limits.subagentTimeoutMs,
        messages: [],
        result,
        resolveResult,
      };

      nextId += 1;
      graph.set(id, new Set(dependencies));
      entries.set(id, entry);
      emit({ type: "SubagentCreated", subagentId: id, task: config.task, dependsOn: dependencies });
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
