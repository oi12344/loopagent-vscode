import type { AgentRunner } from "../../agentRunner";
import type { ReactAgentTool } from "../reactTypes";
import type { WorkflowDiagnosticLog } from "../../../shared/workflowCheckpoint";

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
  diagnosticLog?: readonly WorkflowDiagnosticLog[];
};

export type SubagentDiagnosticLog = WorkflowDiagnosticLog;

export type WorkflowLimits = {
  maxSubagentsPerRun: number;
  maxNestingDepth: number;
  maxConcurrentSubagents: number;
  /**
   * 进度检查间隔。每过这么久看一次日志：有推进就再等一轮，卡住或打转就停止处理。
   * 不再是硬性死线——硬性死线是 `maxSubagentTimeoutMs`。
   */
  subagentTimeoutMs: number;
  /**
   * 绝对上限。推进判定可以一轮轮延长，但延长必须有天花板：一个不停产生日志却永远
   * 不收敛的子智能体，靠"有新消息就是在推进"是判不出来的，只能靠这堵墙拦住。
   */
  maxSubagentTimeoutMs: number;
};

export type SubagentRunnerFactoryInput = {
  subagentId: string;
  task: string;
  role: SubagentRoleId;
  signal: AbortSignal;
  tools: readonly ReactAgentTool[];
};

export type SubagentRunnerFactory = (input: SubagentRunnerFactoryInput) => AgentRunner | Promise<AgentRunner>;
