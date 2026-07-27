import type { AgentRunner } from "../../agentRunner";
import type { ReactAgentTool } from "../reactTypes";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type SubagentRoleId = "explorer" | "reviewer" | "planner" | "executor";

export type SubagentRoleProfile = {
  id: SubagentRoleId;
  systemPrompt: string;
  allowedTools: readonly string[];
};

export type CreateSubagentConfig = {
  task: string;
  role?: SubagentRoleId;
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
  role: SubagentRoleId;
  signal: AbortSignal;
  tools: readonly ReactAgentTool[];
};

export type SubagentRunnerFactory = (input: SubagentRunnerFactoryInput) => AgentRunner | Promise<AgentRunner>;
