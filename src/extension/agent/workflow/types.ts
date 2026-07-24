import type { AgentRunner } from "../../agentRunner";
import type { ReactAgentTool } from "../reactTypes";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type CreateSubagentConfig = {
  task: string;
  dependsOn?: string[];
  toolHints?: string[];
  timeoutMs?: number;
};

export type SubagentResult = {
  status: "completed" | "failed" | "cancelled";
  content?: string;
  error?: string;
  toolCallCount?: number;
};

export type WorkflowLimits = {
  maxSubagentsPerRun: number;
  maxNestingDepth: number;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
};

export type SubagentRunnerFactoryInput = {
  subagentId: string;
  task: string;
  signal: AbortSignal;
  tools: readonly ReactAgentTool[];
};

export type SubagentRunnerFactory = (input: SubagentRunnerFactoryInput) => AgentRunner | Promise<AgentRunner>;
