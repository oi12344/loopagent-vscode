import type { AgentRunner } from "../agentRunner";
import type { AgentPool, ReviewResult, SubagentResult } from "./agentPool";
import type { WorkflowSupervisor } from "./workflowSupervisor";

export function createSuperpowersAgentRunner(supervisor: WorkflowSupervisor): AgentRunner {
  return supervisor;
}

export type ReviewResultBridge = {
  onReview(agentId: string, result: ReviewResult): void;
  wrap(pool: AgentPool): ReviewingAgentPool;
};

export type ReviewReportedSubagentResult = SubagentResult & { review?: ReviewResult };

export type ReviewingAgentPool = {
  dispatch(request: Parameters<AgentPool["dispatch"]>[0]): Promise<ReviewReportedSubagentResult>;
  cancelAll(): void;
};

export function createReviewResultBridge(): ReviewResultBridge {
  const reviews = new Map<string, ReviewResult>();

  return {
    onReview(agentId, result) {
      reviews.set(agentId, result);
    },
    wrap(pool) {
      return {
        async dispatch(request) {
          const result = await pool.dispatch(request);
          const review = reviews.get(request.agentId);
          reviews.delete(request.agentId);
          return review ? { ...result, review } : result;
        },
        cancelAll() {
          pool.cancelAll();
        },
      };
    },
  };
}
