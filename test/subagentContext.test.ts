import { describe, expect, it, vi } from "vitest";

import { createSubagentContext } from "../src/extension/agent/subagentContext";

describe("subagent context", () => {
  it("keeps the configured task, dependencies, assigned tools and role in its initial snapshot", () => {
    const tool = { name: "read", description: "Read files", inputSchema: {}, invoke: () => "" };
    const context = createSubagentContext({
      id: "research",
      task: "Inspect the repository",
      role: "explorer",
      dependsOn: ["prepare"],
      tools: [tool],
    });

    expect(context.snapshot()).toMatchObject({
      id: "research",
      task: "Inspect the repository",
      role: "explorer",
      dependsOn: ["prepare"],
      tools: [tool],
      status: "pending",
      messages: [],
      startedAt: undefined,
      finishedAt: undefined,
      result: undefined,
    });
  });

  it("defaults role to explorer when not provided", () => {
    const context = createSubagentContext({ id: "x", task: "Do something" });
    expect(context.snapshot().role).toBe("explorer");
  });

  it("records only the first start and terminal result", () => {
    vi.useFakeTimers();
    const context = createSubagentContext({ id: "implement", task: "Implement the change" });

    vi.setSystemTime(new Date("2026-07-24T01:00:00Z"));
    context.start();
    vi.setSystemTime(new Date("2026-07-24T01:01:00Z"));
    context.start();
    context.finish({ status: "completed", content: "done" });
    vi.setSystemTime(new Date("2026-07-24T01:02:00Z"));
    context.finish({ status: "failed", error: "ignored" });

    expect(context.snapshot()).toMatchObject({
      status: "completed",
      startedAt: new Date("2026-07-24T01:00:00Z"),
      finishedAt: new Date("2026-07-24T01:01:00Z"),
      result: { status: "completed", content: "done" },
    });
    vi.useRealTimers();
  });

  it("preserves an immutable terminal result", () => {
    const context = createSubagentContext({ id: "implement", task: "Implement the change" });
    const result = { status: "completed" as const, content: "done" };

    context.finish(result);
    result.content = "mutated";
    const snapshot = context.snapshot();
    expect(() => {
      (snapshot.result as { content?: string }).content = "mutated again";
    }).toThrow();

    expect(context.snapshot().result).toEqual({ status: "completed", content: "done" });
  });

  it("appends messages without exposing mutable history", () => {
    const context = createSubagentContext({ id: "review", task: "Review" });
    const message = { role: "user" as const, content: "Check the diff" };

    context.appendMessage(message);
    const snapshot = context.snapshot();

    expect(snapshot.messages).toEqual([message]);
    expect(() => (snapshot.messages as Array<typeof message>).push({ role: "user", content: "mutate" })).toThrow();
    expect(context.snapshot().messages).toEqual([message]);
  });
});
