import { describe, expect, it } from "vitest";

import type { ReactAgentToolRequest } from "../../src/extension/agent/reactTypes";
import { modifyRequestForWorktree } from "../../src/extension/agent/workflowOrchestrator";

const WORKSPACE = "E:\\zz\\loopagent-vscode";
const WORKTREE = "E:\\zz\\loopagent-vscode\\.worktrees\\sub-1";

function request(overrides: Partial<ReactAgentToolRequest> = {}): ReactAgentToolRequest {
  const input = overrides.input ?? { path: `${WORKSPACE}\\src\\extension.ts` };
  return {
    id: "call-1",
    name: "readFile",
    rawArguments: JSON.stringify(input),
    input,
    ...overrides,
  };
}

describe("modifyRequestForWorktree", () => {
  it("rewrites workspace paths in input for tools that touch the filesystem", () => {
    const modified = modifyRequestForWorktree(request(), WORKTREE, WORKSPACE);

    expect(modified.input).toEqual({ path: `${WORKTREE}\\src\\extension.ts` });
  });

  it("keeps rawArguments consistent with the rewritten input", () => {
    const modified = modifyRequestForWorktree(request(), WORKTREE, WORKSPACE);

    // rawArguments feeds computeToolCallSignature (dedup). If it kept the original
    // path while input pointed at the worktree, dedup would key off a path that is
    // never executed.
    expect(JSON.parse(modified.rawArguments)).toEqual(modified.input);
    expect(modified.rawArguments).not.toContain("loopagent-vscode\\\\src");
  });

  it("rewrites paths nested in objects and arrays", () => {
    const input = {
      command: `cd ${WORKSPACE} && npm test`,
      files: [`${WORKSPACE}\\a.ts`, `${WORKSPACE}\\b.ts`],
      nested: { cwd: WORKSPACE, unrelated: 7, flag: true },
    };
    const modified = modifyRequestForWorktree(request({ name: "runCommand", input }), WORKTREE, WORKSPACE);

    expect(modified.input).toEqual({
      command: `cd ${WORKTREE} && npm test`,
      files: [`${WORKTREE}\\a.ts`, `${WORKTREE}\\b.ts`],
      nested: { cwd: WORKTREE, unrelated: 7, flag: true },
    });
  });

  it("replaces every occurrence, not just the first", () => {
    const input = { command: `cp ${WORKSPACE}\\a.ts ${WORKSPACE}\\b.ts` };
    const modified = modifyRequestForWorktree(request({ name: "runCommand", input }), WORKTREE, WORKSPACE);

    expect(modified.input).toEqual({ command: `cp ${WORKTREE}\\a.ts ${WORKTREE}\\b.ts` });
  });

  it("leaves requests for unlisted tools untouched", () => {
    const original = request({ name: "webSearch" });

    expect(modifyRequestForWorktree(original, WORKTREE, WORKSPACE)).toBe(original);
  });

  it("does not mutate the original request", () => {
    const original = request();
    const snapshot = structuredClone(original);

    modifyRequestForWorktree(original, WORKTREE, WORKSPACE);

    expect(original).toEqual(snapshot);
  });

  it("returns the request unchanged when the workspace path is empty", () => {
    const original = request();

    expect(modifyRequestForWorktree(original, WORKTREE, "")).toBe(original);
  });

  it("preserves rawArguments when the arguments failed to parse", () => {
    const original = request({ rawArguments: "{not json", parseError: "Unexpected token", input: undefined });

    const modified = modifyRequestForWorktree(original, WORKTREE, WORKSPACE);

    expect(modified.rawArguments).toBe("{not json");
  });
});
