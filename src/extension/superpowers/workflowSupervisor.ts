import type { AgentRunRequest, AgentRunner } from "../agentRunner";
import type { AgentPool, AgentRole, ReviewResult, SubagentResult } from "./agentPool";
import type { SkillCatalog } from "./superpowersTypes";
import type { WorkflowStore } from "./workflowStore";
import type { SuperpowersCheckpoint, WorkflowPhase } from "../../shared/chatTypes";
import type { HostToWebviewMessage } from "../../shared/messages";

const REQUIRED_SKILLS = [
  "using-superpowers",
  "brainstorming",
  "writing-plans",
  "subagent-driven-development",
  "test-driven-development",
  "requesting-code-review",
  "verification-before-completion",
];

type SuperpowersResumeState = { kind: "superpowers"; checkpoint: SuperpowersCheckpoint };

export type WorkflowSupervisor = AgentRunner;

export type CreateWorkflowSupervisorOptions = {
  agentPool: AgentPool;
  workflowStore: WorkflowStore;
  model: unknown;
  catalog?: SkillCatalog;
  loadSkill?: (name: string) => Promise<unknown>;
  planPath?: string;
  validatePlan?: () => string | undefined;
  validateLedger?: () => string | undefined;
  provideContext?: (result: SubagentResult, role: AgentRole) => string | undefined;
};

export function createWorkflowSupervisor(options: CreateWorkflowSupervisorOptions): WorkflowSupervisor {
  return {
    async *run(request) {
      const conversationId = request.conversationId;
      if (!conversationId) {
        yield failure(request.runId, "Superpowers workflow requires a conversation id");
        return;
      }

      let checkpoint = resumeCheckpoint(request) ?? options.workflowStore.load(conversationId) ?? createCheckpoint(request, conversationId, options.planPath);
      checkpoint = { ...checkpoint, conversationId, runId: request.runId, activeAgentId: undefined, updatedAt: Date.now() };

      const save = (phase: WorkflowPhase, changes: Partial<SuperpowersCheckpoint> = {}) => {
        checkpoint = { ...checkpoint, ...changes, phase, updatedAt: Date.now() };
        options.workflowStore.save(checkpoint);
      };
      const event = (message: string): HostToWebviewMessage => ({ type: "agentEvent", runId: request.runId, message });
      const wait = (phase: WorkflowPhase, waitingFor: string) => {
        save(phase, { waitingFor, activeAgentId: undefined });
        return event(`Waiting for ${waitingFor}`);
      };

      try {
        if (request.signal.aborted) return;

        if (checkpoint.phase === "bootstrap") {
          save("bootstrap");
          for (const skill of REQUIRED_SKILLS) await loadSkill(options, skill);
          save("route", { skillNames: [...REQUIRED_SKILLS] });
        }

        if (checkpoint.phase === "route") {
          save("brainstorming");
        }
        if (checkpoint.phase === "brainstorming") {
          yield wait("designApproval", "design approval");
          return;
        }
        if (checkpoint.phase === "designApproval") {
          save("writeSpec", { waitingFor: undefined });
        }
        if (checkpoint.phase === "writeSpec") {
          yield wait("specReview", "spec review");
          return;
        }
        if (checkpoint.phase === "specReview") {
          save("writePlan", { waitingFor: undefined });
        }
        if (checkpoint.phase === "writePlan") {
          yield wait("planApproval", "plan approval");
          return;
        }
        if (checkpoint.phase === "planApproval") {
          save("preflight", { waitingFor: undefined });
        }

        if (checkpoint.phase === "preflight") {
          const inconsistency = options.validatePlan?.() ?? options.validateLedger?.();
          if (inconsistency) {
            yield wait("blocked", inconsistency);
            return;
          }
          save("implement");
        }

        if (checkpoint.phase === "implement") {
          const result = yield* dispatch(options, request, checkpoint, save, "implementer", "implement", request.task, event);
          if (!result) return;
          if (result.status === "NEEDS_CONTEXT" || result.status === "BLOCKED") {
            yield wait("blocked", result.summary);
            return;
          }
          save("review");
        }

        if (checkpoint.phase === "review") {
          const review = yield* dispatch(options, request, checkpoint, save, "taskReviewer", "review", `Review: ${request.task}`, event);
          if (!review) return;
          if (review.status === "NEEDS_CONTEXT" || review.status === "BLOCKED") {
            yield wait("blocked", review.summary);
            return;
          }
          const decision = reviewResult(review);
          if (!decision) {
            yield wait("blocked", "review result is incomplete");
            return;
          }
          if (!decision.specCompliant || !decision.qualityApproved) {
            save("fix");
          } else {
            save("finalReview");
          }
        }

        if (checkpoint.phase === "fix") {
          const result = yield* dispatch(options, request, checkpoint, save, "fixer", "fix", `Fix review findings: ${request.task}`, event);
          if (!result) return;
          if (result.status === "NEEDS_CONTEXT" || result.status === "BLOCKED") {
            yield wait("blocked", result.summary);
            return;
          }
          save("review");
          const review = yield* dispatch(options, request, checkpoint, save, "taskReviewer", "review", `Re-review: ${request.task}`, event);
          if (!review) return;
          if (review.status === "NEEDS_CONTEXT" || review.status === "BLOCKED") {
            yield wait("blocked", review.summary);
            return;
          }
          const decision = reviewResult(review);
          if (!decision || !decision.specCompliant || !decision.qualityApproved) {
            yield wait("blocked", decision ? "review still has findings" : "review result is incomplete");
            return;
          }
          save("finalReview");
        }

        if (checkpoint.phase === "finalReview") {
          const finalReview = yield* dispatch(options, request, checkpoint, save, "finalReviewer", "finalReview", `Final review: ${request.task}`, event);
          if (!finalReview) return;
          const decision = reviewResult(finalReview);
          if (finalReview.status !== "DONE" || !decision || !decision.specCompliant || !decision.qualityApproved) {
            yield wait("blocked", finalReview.summary || "final review failed");
            return;
          }
          save("verification");
        }

        if (checkpoint.phase === "verification") {
          save("finished", { waitingFor: undefined, activeAgentId: undefined });
          yield { type: "runFinished", runId: request.runId };
        }
      } catch (error) {
        if (request.signal.aborted) {
          options.agentPool.cancelAll();
          save(checkpoint.phase, { activeAgentId: undefined });
          return;
        }
        yield failure(request.runId, error instanceof Error ? error.message : "Superpowers workflow failed");
      }
    },
  };
}

async function* dispatch(
  options: CreateWorkflowSupervisorOptions,
  request: AgentRunRequest,
  checkpoint: SuperpowersCheckpoint,
  save: (phase: WorkflowPhase, changes?: Partial<SuperpowersCheckpoint>) => void,
  role: AgentRole,
  phase: WorkflowPhase,
  task: string,
  event: (message: string) => HostToWebviewMessage,
): AsyncGenerator<HostToWebviewMessage, SubagentResult | undefined> {
  const agentId = `${role}-${checkpoint.taskIndex + 1}`;
  save(phase, { activeAgentId: agentId });
  yield event(`${role} started`);
  if (request.signal.aborted) return undefined;
  let result = await options.agentPool.dispatch({ agentId, role, task, model: options.model, signal: request.signal });
  if (request.signal.aborted) {
    options.agentPool.cancelAll();
    return undefined;
  }
  const context = result.status === "NEEDS_CONTEXT" ? options.provideContext?.(result, role)?.trim() : undefined;
  if (context) {
    yield event(`${role} received additional context`);
    result = await options.agentPool.dispatch({
      agentId: `${agentId}-context`,
      role,
      task: `${task}\n\nAdditional context:\n${context}`,
      model: options.model,
      signal: request.signal,
    });
    if (request.signal.aborted) {
      options.agentPool.cancelAll();
      return undefined;
    }
  }
  save(phase, { activeAgentId: undefined });
  yield event(`${role} ${result.status}`);
  return result;
}

function createCheckpoint(request: AgentRunRequest, conversationId: string, planPath?: string): SuperpowersCheckpoint {
  return {
    version: 1,
    conversationId,
    runId: request.runId,
    phase: "bootstrap",
    skillNames: [],
    ...(planPath ? { planPath } : {}),
    taskIndex: 0,
    updatedAt: Date.now(),
  };
}

function resumeCheckpoint(request: AgentRunRequest): SuperpowersCheckpoint | undefined {
  const resumeState = request.resumeState as unknown;
  if (!resumeState || typeof resumeState !== "object") return undefined;
  const candidate = resumeState as Partial<SuperpowersResumeState>;
  return candidate.kind === "superpowers" ? candidate.checkpoint : undefined;
}

function reviewResult(result: SubagentResult): ReviewResult | undefined {
  const candidate = result as SubagentResult & Partial<ReviewResult>;
  return typeof candidate.specCompliant === "boolean"
    && typeof candidate.qualityApproved === "boolean"
    && Array.isArray(candidate.findings)
    ? { specCompliant: candidate.specCompliant, qualityApproved: candidate.qualityApproved, findings: candidate.findings }
    : undefined;
}

async function loadSkill(options: CreateWorkflowSupervisorOptions, name: string): Promise<void> {
  if (options.loadSkill) {
    await options.loadSkill(name);
    return;
  }
  if (options.catalog) {
    await options.catalog.load(name);
    return;
  }
  throw new Error(`Required skill is not loaded: ${name}`);
}

function failure(runId: string, message: string): HostToWebviewMessage {
  return { type: "runFailed", runId, message };
}
