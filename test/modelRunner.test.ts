import { describe, expect, it } from "vitest";

import { createModelRunner, startModelRun, type ModelRunner } from "../src/extension/model/modelRunner";
import type { HostToWebviewMessage } from "../src/shared/messages";
import type { ModelProvider, ModelStreamEvent } from "../src/extension/model/types";

function createProvider(events: Array<ModelStreamEvent>): ModelProvider {
  return {
    id: "test",
    displayName: "Test Model",
    async *stream() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("createModelRunner", () => {
  it("forwards provider reasoning deltas without replacing their content", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const provider = createProvider([
      { type: "reasoningDelta", content: "Inspecting the active file. " },
      { type: "reasoningDelta", content: "Checking related callers." },
      { type: "contentDelta", content: "Done." },
    ]);

    const runner = createModelRunner(provider);
    const handle = startModelRun({
      runner,
      messages: [{ role: "user", content: "Inspect code" }],
      signal: new AbortController().signal,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(postedMessages).toContainEqual({
      type: "assistantReasoningDelta",
      runId: handle.runId,
      content: "Inspecting the active file. ",
    });
    expect(postedMessages).toContainEqual({
      type: "assistantReasoningDelta",
      runId: handle.runId,
      content: "Checking related callers.",
    });
    expect(postedMessages).toContainEqual({
      type: "assistantDelta",
      runId: handle.runId,
      content: "Done.",
    });

    // Verify no assistantThinking messages were generated
    expect(postedMessages.some((message) => message.type === "assistantThinking")).toBe(false);
  });

  it("posts assistantStarted and assistantFinished messages", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const provider = createProvider([
      { type: "contentDelta", content: "Response content." },
    ]);

    const runner = createModelRunner(provider, "Custom Provider");
    const handle = startModelRun({
      runner,
      messages: [{ role: "user", content: "Test" }],
      signal: new AbortController().signal,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(postedMessages[0]).toEqual({
      type: "assistantStarted",
      runId: handle.runId,
      provider: "Custom Provider",
    });
    expect(postedMessages[postedMessages.length - 1]).toEqual({
      type: "assistantFinished",
      runId: handle.runId,
    });
  });

  it("respects abort signal", async () => {
    let yieldCount = 0;
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test",
      async *stream() {
        yield { type: "reasoningDelta", content: "First" } as const;
        yieldCount++;
        yield { type: "reasoningDelta", content: "Second" } as const;
        yieldCount++;
      },
    };

    const abortController = new AbortController();
    const postedMessages: HostToWebviewMessage[] = [];
    const runner = createModelRunner(provider);

    const promise = (async () => {
      for await (const message of runner.run({
        runId: "test-run",
        messages: [{ role: "user", content: "Test" }],
        signal: abortController.signal,
      })) {
        postedMessages.push(message);
        if (postedMessages.length === 2) {
          // After first reasoning delta posted, abort
          abortController.abort();
        }
      }
    })();

    await promise;

    // Should have posted assistantStarted and one reasoningDelta before abort
    expect(postedMessages).toContainEqual({
      type: "assistantReasoningDelta",
      runId: "test-run",
      content: "First",
    });
    // The second yield should not have been processed due to abort
    expect(yieldCount).toBeLessThanOrEqual(1);
  });

  it("uses default provider name if not specified", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const provider = createProvider([
      { type: "contentDelta", content: "Test" },
    ]);

    const runner = createModelRunner(provider);
    const handle = startModelRun({
      runner,
      messages: [{ role: "user", content: "Test" }],
      signal: new AbortController().signal,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(postedMessages[0]).toEqual({
      type: "assistantStarted",
      runId: handle.runId,
      provider: provider.displayName,
    });
  });
});

describe("startModelRun", () => {
  it("posts every message produced by the runner", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const runner: ModelRunner = {
      run: async function* ({ runId, messages }) {
        yield { type: "assistantStarted", runId, provider: "Test" };
        yield { type: "assistantReasoningDelta", runId, content: "Thinking..." };
        yield { type: "assistantDelta", runId, content: "Response." };
        yield { type: "assistantFinished", runId };
      },
    };

    const handle = startModelRun({
      runner,
      messages: [{ role: "user", content: "Test" }],
      signal: new AbortController().signal,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(handle.runId).toMatch(/^run-/);
    expect(postedMessages).toEqual([
      { type: "assistantStarted", runId: handle.runId, provider: "Test" },
      { type: "assistantReasoningDelta", runId: handle.runId, content: "Thinking..." },
      { type: "assistantDelta", runId: handle.runId, content: "Response." },
      { type: "assistantFinished", runId: handle.runId },
    ]);
  });

  it("posts runFailed when the runner throws", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const runner: ModelRunner = {
      run: async function* ({ runId }) {
        yield { type: "assistantStarted", runId, provider: "Test" };
        throw new Error("provider crashed");
      },
    };

    const handle = startModelRun({
      runner,
      messages: [{ role: "user", content: "Test" }],
      signal: new AbortController().signal,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(postedMessages).toEqual([
      { type: "assistantStarted", runId: handle.runId, provider: "Test" },
      { type: "runFailed", runId: handle.runId, message: "provider crashed" },
    ]);
  });
});
