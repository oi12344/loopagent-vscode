import type { ReactAgentMessage } from "../agent/reactTypes";

export type AgentRole = "implementer" | "taskReviewer" | "fixer" | "finalReviewer";
export type SubagentStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

export type SubagentResult = {
  status: SubagentStatus;
  summary: string;
  reportPath: string;
  commit: string;
  tests: string[];
  concerns?: string[];
};

export type ReviewResult = {
  specCompliant: boolean;
  qualityApproved: boolean;
  findings: string[];
};

export type SubagentRunRequest = {
  agentId: string;
  role: AgentRole;
  task: string;
  model: unknown;
  runId: string;
  messages: ReactAgentMessage[];
  requiredToolNames: string[];
  signal: AbortSignal;
};

export type AgentPool = {
  dispatch(request: {
    agentId: string;
    role: AgentRole;
    task: string;
    model: unknown;
    signal: AbortSignal;
  }): Promise<SubagentResult>;
  cancelAll(): void;
};

export type CreateAgentPoolOptions = {
  brief: string;
  globalConstraints: string;
  relevantPaths?: string[];
  previousReports?: string[];
  run(request: SubagentRunRequest): Promise<SubagentResult>;
};

const WRITER_ROLES = new Set<AgentRole>(["implementer", "fixer"]);

export function createAgentPool({
  brief,
  globalConstraints,
  relevantPaths = [],
  previousReports = [],
  run,
}: CreateAgentPoolOptions): AgentPool {
  const controllers = new Set<AbortController>();
  let writerActive = false;
  let runNumber = 0;

  return {
    async dispatch(request) {
      const isWriter = WRITER_ROLES.has(request.role);
      if (isWriter && writerActive) throw new Error("writer already active");

      const controller = new AbortController();
      const abort = () => controller.abort();
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      if (isWriter) writerActive = true;

      try {
        return await run({
          ...request,
          runId: `subagent-${++runNumber}`,
          messages: createFreshMessages(brief, globalConstraints, relevantPaths, previousReports, request.task, request.role),
          requiredToolNames: requiredToolNamesForRole(request.role),
          signal: controller.signal,
        });
      } finally {
        controllers.delete(controller);
        request.signal.removeEventListener("abort", abort);
        if (isWriter) writerActive = false;
      }
    },
    cancelAll() {
      for (const controller of controllers) controller.abort();
    },
  };
}

function createFreshMessages(
  brief: string,
  globalConstraints: string,
  relevantPaths: string[],
  previousReports: string[],
  task: string,
  role: AgentRole,
): ReactAgentMessage[] {
  const requiredToolNames = requiredToolNamesForRole(role);
  return [
    { role: "system", content: globalConstraints },
    { role: "user", content: `Task brief:\n${brief}` },
    ...(relevantPaths.length === 0 ? [] : [{ role: "user" as const, content: `Relevant paths:\n${relevantPaths.join("\n")}` }]),
    ...(previousReports.length === 0 ? [] : [{ role: "user" as const, content: `Previous reports:\n${previousReports.join("\n")}` }]),
    { role: "user", content: `Before finishing, call required tool(s): ${requiredToolNames.join(", ")}. Do not finish without a successful structured report.` },
    { role: "user", content: task },
  ];
}

function requiredToolNamesForRole(role: AgentRole): string[] {
  return role === "taskReviewer" || role === "finalReviewer"
    ? ["reportSubagentResult", "reportReview"]
    : ["reportSubagentResult"];
}
