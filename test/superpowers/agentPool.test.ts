import { describe, expect, it, vi } from "vitest";

import { createAgentPool } from "../../src/extension/superpowers/agentPool";

describe("AgentPool", () => {
  it("rejects a second writer while an implementer is active", async () => {
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async ({ runId, messages }: { runId: string; messages: unknown[] }) => {
      await active;
      return { status: "DONE" as const, summary: runId, reportPath: "report.md", commit: "abc", tests: [] };
    });
    const pool = createAgentPool({ run, globalConstraints: "constraints", brief: "brief" });

    const implementer = pool.dispatch({
      agentId: "implementer-1",
      role: "implementer",
      task: "implement",
      model: "model",
      signal: new AbortController().signal,
    });

    await expect(
      pool.dispatch({
        agentId: "fixer-1",
        role: "fixer",
        task: "fix",
        model: "model",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("writer already active");

    release();
    await expect(implementer).resolves.toMatchObject({ status: "DONE" });
  });

  it("gives every dispatch a distinct run ID and message array", async () => {
    const requests: Array<{ runId: string; messages: unknown[] }> = [];
    const pool = createAgentPool({
      globalConstraints: "constraints",
      brief: "brief",
      run: async (request) => {
        requests.push(request);
        return { status: "DONE", summary: "done", reportPath: "report.md", commit: "abc", tests: [] };
      },
    });

    await pool.dispatch({ agentId: "review-1", role: "taskReviewer", task: "review", model: "model", signal: new AbortController().signal });
    await pool.dispatch({ agentId: "review-2", role: "finalReviewer", task: "final review", model: "model", signal: new AbortController().signal });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.runId).not.toBe(requests[1]?.runId);
    expect(requests[0]?.messages).not.toBe(requests[1]?.messages);
  });

  it("includes fresh context and structured reporting requirements for each role", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: string }>; requiredToolNames: string[] }> = [];
    const pool = createAgentPool({
      globalConstraints: "constraints",
      brief: "brief",
      run: async (request) => {
        requests.push({ messages: request.messages, requiredToolNames: request.requiredToolNames });
        return { status: "DONE", summary: "done", reportPath: "report.md", commit: "abc", tests: [] };
      },
    });

    await pool.dispatch({ agentId: "implementer-1", role: "implementer", task: "implement", model: "model", signal: new AbortController().signal });
    await pool.dispatch({ agentId: "review-1", role: "taskReviewer", task: "review", model: "model", signal: new AbortController().signal });

    expect(requests[0]?.messages.some((message) => /reportSubagentResult/.test(message.content))).toBe(true);
    expect(requests[0]?.requiredToolNames).toEqual(["reportSubagentResult"]);
    expect(requests[1]?.messages.some((message) => /reportSubagentResult.*reportReview/s.test(message.content))).toBe(true);
    expect(requests[1]?.requiredToolNames).toEqual(["reportSubagentResult", "reportReview"]);
  });

  it("puts applicable skill bodies into fresh messages", async () => {
    let messages: Array<{ role: string; content: string }> = [];
    const pool = createAgentPool({
      globalConstraints: "constraints",
      brief: "brief",
      run: async (request) => {
        messages = request.messages;
        return { status: "DONE", summary: "done", reportPath: "report.md", commit: "abc", tests: [] };
      },
    });

    await pool.dispatch({
      agentId: "implementer-1",
      role: "implementer",
      task: "implement",
      model: "model",
      context: "# using-superpowers\nUse the workflow.\n# brainstorming\nClarify the design.",
      signal: new AbortController().signal,
    });

    expect(messages.some((message) => message.content.includes("# using-superpowers"))).toBe(true);
    expect(messages.some((message) => message.content.includes("# brainstorming"))).toBe(true);
  });
});
