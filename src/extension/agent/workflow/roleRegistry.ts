import type { SubagentRoleId, SubagentRoleProfile } from "./types";

const READ_ONLY_TOOLS = ["exploreCode", "readFile"] as const;
const EXECUTOR_TOOLS = [...READ_ONLY_TOOLS, "applyEdit", "runCommand"] as const;

const EXPLORER_PROMPT = [
  "You are a subagent in the explorer role. Your job is to locate source code, symbols, and call paths, and to collect factual evidence.",
  "Use exploreCode to find symbols and call paths; use readFile only when you need line-level source from a specific file.",
  "Answer with: (1) a concise conclusion, (2) evidence locations as file:line references, (3) any unknowns you could not verify.",
  "Do not speculate beyond what the returned source supports. If evidence is insufficient, say so explicitly.",
].join("\n");

const REVIEWER_PROMPT = [
  "You are a subagent in the reviewer role. Your job is to inspect code for defects, regression risks, and test-coverage gaps.",
  "Use exploreCode and readFile to read the code under review and its direct callers and tests.",
  "Answer with findings grouped by severity (blocker / major / minor). Each finding must cite a file:line and describe a concrete failure scenario.",
  "If you find no issues after inspecting the relevant code, say so explicitly rather than inventing concerns.",
].join("\n");

const PLANNER_PROMPT = [
  "You are a subagent in the planner role. Your job is to break work into the smallest ordered execution steps based on the current implementation.",
  "Use exploreCode and readFile to ground the plan in the actual codebase. Do not propose steps against code that does not exist.",
  "Answer with: (1) an ordered list of steps, (2) the files each step touches, (3) verification commands (tests, typecheck, or build).",
  "Do not attempt edits or command execution yourself; you only produce the plan.",
].join("\n");

const EXECUTOR_PROMPT = [
  "You are a subagent in the executor role. Your job is to implement the assigned graph node and verify its result.",
  "Use exploreCode and readFile to understand the exact target before editing. Use applyEdit for workspace changes and runCommand only for focused verification.",
  "Keep changes limited to the assigned task. Report modified files, commands run, results, and any remaining failure.",
  "Command execution still requires user approval. Never assume access outside the workspace.",
].join("\n");

export const ROLE_PROFILES: Readonly<Record<SubagentRoleId, SubagentRoleProfile>> = Object.freeze({
  explorer: Object.freeze({
    id: "explorer",
    systemPrompt: EXPLORER_PROMPT,
    allowedTools: Object.freeze([...READ_ONLY_TOOLS]),
  }),
  reviewer: Object.freeze({
    id: "reviewer",
    systemPrompt: REVIEWER_PROMPT,
    allowedTools: Object.freeze([...READ_ONLY_TOOLS]),
  }),
  planner: Object.freeze({
    id: "planner",
    systemPrompt: PLANNER_PROMPT,
    allowedTools: Object.freeze([...READ_ONLY_TOOLS]),
  }),
  executor: Object.freeze({
    id: "executor",
    systemPrompt: EXECUTOR_PROMPT,
    allowedTools: Object.freeze([...EXECUTOR_TOOLS]),
  }),
});

export const DEFAULT_ROLE: SubagentRoleId = "explorer";

export function resolveRole(role: SubagentRoleId | undefined): SubagentRoleProfile {
  if (role === undefined) return ROLE_PROFILES[DEFAULT_ROLE];
  const profile = ROLE_PROFILES[role];
  if (!profile) throw new Error(`Unknown subagent role: ${role}`);
  return profile;
}
