import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { AgentRunRequest, AgentRunner } from "../agentRunner";
import type { AgentRole, ReviewResult, SubagentResult } from "./agentPool";
import type { SkillCatalog } from "./superpowersTypes";
import type { ReviewReportedSubagentResult, ReviewingAgentPool } from "./superpowersAgentRunner";
import type { WorkflowStore } from "./workflowStore";
import { isSuperpowersCheckpoint, type SuperpowersCheckpoint, type WorkflowPhase } from "../../shared/chatTypes";
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
  agentPool: ReviewingAgentPool;
  workflowStore: WorkflowStore;
  model: unknown;
  catalog?: SkillCatalog;
  loadSkill?: (name: string) => Promise<unknown>;
  planPath?: string;
  workspaceRoot?: string;
  validatePlan?: (checkpoint: SuperpowersCheckpoint) => string | undefined;
  validateLedger?: (checkpoint: SuperpowersCheckpoint) => string | undefined;
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

      const resumed = resumeCheckpoint(request, conversationId);
      if (resumed === null) {
        yield failure(request.runId, "Invalid Superpowers resume checkpoint");
        return;
      }
      let checkpoint = resumed ?? options.workflowStore.load(conversationId) ?? createCheckpoint(request, conversationId, options.planPath);
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
      const cancel = () => {
        options.agentPool.cancelAll();
        save(checkpoint.phase, { activeAgentId: undefined, waitingFor: "cancelled" });
        return failure(request.runId, "Superpowers workflow cancelled");
      };

      try {
        if (request.signal.aborted) {
          yield cancel();
          return;
        }

        let skillContext = "";
        const skillNames = checkpoint.skillNames.length > 0 ? checkpoint.skillNames : REQUIRED_SKILLS;
        if (checkpoint.phase === "bootstrap") {
          save("bootstrap");
          skillContext = await loadSkillContext(options, skillNames, true);
          save("route", { skillNames: [...skillNames] });
        } else {
          skillContext = await loadSkillContext(options, skillNames, false);
        }

        if (checkpoint.phase === "route") {
          save("brainstorming");
        }
        if (checkpoint.phase === "brainstorming") {
          save("designApproval");
        }
        if (checkpoint.phase === "designApproval") {
          save("writeSpec", { waitingFor: undefined });
        }
        if (checkpoint.phase === "writeSpec") {
          save("specReview");
        }
        if (checkpoint.phase === "specReview") {
          save("writePlan", { waitingFor: undefined });
        }
        if (checkpoint.phase === "writePlan") {
          save("planApproval");
        }
        if (checkpoint.phase === "planApproval") {
          save("preflight", { waitingFor: undefined });
        }

        if (checkpoint.phase === "preflight") {
          const planError = checkpoint.planPath
            ? options.validatePlan?.(checkpoint) ?? validatePlan(options, checkpoint)
            : undefined;
          const ledgerError = shouldValidateLedger(options, checkpoint)
            ? options.validateLedger?.(checkpoint) ?? validateLedger(options)
            : undefined;
          const inconsistency = planError ?? ledgerError;
          if (inconsistency) {
            yield wait("blocked", inconsistency);
            return;
          }
          save("implement");
        }

        if (checkpoint.phase === "implement") {
          const result = yield* dispatch(options, request, checkpoint, save, "implementer", "implement", request.task, event, skillContext);
          if (!result) return;
          if (result.status === "NEEDS_CONTEXT" || result.status === "BLOCKED") {
            yield wait("blocked", result.summary);
            return;
          }
          save("review");
        }

        if (checkpoint.phase === "review") {
          const review = yield* dispatch(options, request, checkpoint, save, "taskReviewer", "review", `Review: ${request.task}`, event, skillContext);
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
          const result = yield* dispatch(options, request, checkpoint, save, "fixer", "fix", `Fix review findings: ${request.task}`, event, skillContext);
          if (!result) return;
          if (result.status === "NEEDS_CONTEXT" || result.status === "BLOCKED") {
            yield wait("blocked", result.summary);
            return;
          }
          save("review");
          const review = yield* dispatch(options, request, checkpoint, save, "taskReviewer", "review", `Re-review: ${request.task}`, event, skillContext);
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
          const finalReview = yield* dispatch(options, request, checkpoint, save, "finalReviewer", "finalReview", `Final review: ${request.task}`, event, skillContext);
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
          yield cancel();
          return;
        }
        const message = error instanceof Error ? error.message : "Superpowers workflow failed";
        save("blocked", { activeAgentId: undefined, waitingFor: message });
        yield failure(request.runId, message);
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
  skillContext: string,
): AsyncGenerator<HostToWebviewMessage, ReviewReportedSubagentResult | undefined> {
  const agentId = `${role}-${checkpoint.taskIndex + 1}`;
  save(phase, { activeAgentId: agentId, waitingFor: undefined });
  yield event(`${role} started`);
  if (request.signal.aborted) throw new Error("Workflow cancelled");
  let result = await options.agentPool.dispatch({ agentId, role, task, model: options.model, signal: request.signal, context: skillContext });
  if (request.signal.aborted) {
    throw new Error("Workflow cancelled");
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
      context: skillContext,
    });
    if (request.signal.aborted) {
      throw new Error("Workflow cancelled");
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

function resumeCheckpoint(request: AgentRunRequest, conversationId: string): SuperpowersCheckpoint | undefined | null {
  const resumeState = request.resumeState as unknown;
  if (!resumeState || typeof resumeState !== "object") return undefined;
  const candidate = resumeState as Partial<SuperpowersResumeState>;
  if (candidate.kind !== "superpowers") return undefined;
  const checkpoint = candidate.checkpoint;
  return isSuperpowersCheckpoint(checkpoint, conversationId) && checkpoint.runId.trim().length > 0 ? checkpoint : null;
}

function reviewResult(result: Awaited<ReturnType<ReviewingAgentPool["dispatch"]>>): ReviewResult | undefined {
  const review = result.review;
  return review
    && typeof review.specCompliant === "boolean"
    && typeof review.qualityApproved === "boolean"
    && Array.isArray(review.findings)
    ? review
    : undefined;
}

async function loadSkillContext(options: CreateWorkflowSupervisorOptions, names: readonly string[], required: boolean): Promise<string> {
  if (!options.loadSkill && !options.catalog) {
    if (required) throw new Error("Required skill loader is unavailable");
    return "";
  }

  const sections: string[] = [];
  for (const name of names) {
    const loaded = options.loadSkill ? await options.loadSkill(name) : await options.catalog!.load(name);
    const content = typeof loaded === "string"
      ? loaded
      : loaded && typeof loaded === "object" && typeof (loaded as { content?: unknown }).content === "string"
        ? (loaded as { content: string }).content
        : "";
    if (!content.trim()) throw new Error(`Required skill content is empty: ${name}`);
    sections.push(`## Skill: ${name}\n${content}`);
  }
  return sections.join("\n\n");
}

function validatePlan(options: CreateWorkflowSupervisorOptions, checkpoint: SuperpowersCheckpoint): string | undefined {
  return validateWorkspaceFile(options.workspaceRoot ?? "", checkpoint.planPath, "plan");
}

function validateLedger(options: CreateWorkflowSupervisorOptions): string | undefined {
  return validateWorkspaceFile(options.workspaceRoot ?? "", ".superpowers/sdd/progress.md", "ledger");
}

function shouldValidateLedger(options: CreateWorkflowSupervisorOptions, checkpoint: SuperpowersCheckpoint): boolean {
  if (checkpoint.taskIndex > 0 || Boolean(checkpoint.baseCommit?.trim())) return true;
  if (!options.workspaceRoot?.trim()) return false;
  return existsSync(resolve(options.workspaceRoot, ".superpowers/sdd/progress.md"));
}

function validateWorkspaceFile(workspaceRoot: string, requestedPath: string | undefined, label: string): string | undefined {
  if (!workspaceRoot.trim()) return "Superpowers workspace is unavailable";
  if (!requestedPath?.trim()) return `Superpowers ${label} path is missing`;
  if (isAbsolute(requestedPath)) return `Superpowers ${label} path must be workspace-relative`;

  const root = resolve(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return `Superpowers ${label} path is outside the workspace`;
  if (!existsSync(candidate)) return `Superpowers ${label} file does not exist: ${requestedPath}`;

  try {
    if (!statSync(candidate).isFile() || !readFileSync(candidate, "utf8").trim()) {
      return `Superpowers ${label} file is empty: ${requestedPath}`;
    }
  } catch (error) {
    return `Superpowers ${label} file cannot be read: ${error instanceof Error ? error.message : requestedPath}`;
  }
  return undefined;
}

function failure(runId: string, message: string): HostToWebviewMessage {
  return { type: "runFailed", runId, message };
}
