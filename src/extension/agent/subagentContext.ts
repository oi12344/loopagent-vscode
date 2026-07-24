import type { ReactAgentMessage, ReactAgentTool } from "./reactTypes";
import type { SubagentResult, SubagentStatus } from "./workflow/types";

export type CreateSubagentContextInput = {
  id: string;
  task: string;
  dependsOn?: readonly string[];
  tools?: readonly ReactAgentTool[];
};

export type SubagentContextSnapshot = {
  readonly id: string;
  readonly task: string;
  readonly dependsOn: readonly string[];
  readonly tools: readonly ReactAgentTool[];
  readonly status: SubagentStatus;
  readonly result?: SubagentResult;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly messages: readonly ReactAgentMessage[];
};

export type SubagentContext = {
  snapshot(): SubagentContextSnapshot;
  start(): void;
  finish(result: SubagentResult): void;
  appendMessage(message: ReactAgentMessage): void;
};

export function createSubagentContext({ id, task, dependsOn = [], tools = [] }: CreateSubagentContextInput): SubagentContext {
  let status: SubagentStatus = "pending";
  let result: SubagentResult | undefined;
  let startedAt: Date | undefined;
  let finishedAt: Date | undefined;
  const messages: ReactAgentMessage[] = [];
  const dependencies = Object.freeze([...dependsOn]);
  const assignedTools = Object.freeze([...tools]);

  return {
    snapshot() {
      return Object.freeze({
        id,
        task,
        dependsOn: dependencies,
        tools: assignedTools,
        status,
        result: result && copyResult(result),
        startedAt: startedAt && new Date(startedAt),
        finishedAt: finishedAt && new Date(finishedAt),
        messages: Object.freeze(messages.map(copyMessage)),
      });
    },
    start() {
      if (startedAt || finishedAt) return;
      status = "running";
      startedAt = new Date();
    },
    finish(nextResult) {
      if (finishedAt) return;
      status = nextResult.status;
      result = copyResult(nextResult);
      finishedAt = new Date();
    },
    appendMessage(message) {
      messages.push(copyMessage(message));
    },
  };
}

function copyMessage(message: ReactAgentMessage): ReactAgentMessage {
  return deepFreeze(structuredClone(message));
}

function copyResult(result: SubagentResult): SubagentResult {
  return deepFreeze(structuredClone(result));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
