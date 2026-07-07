import { describe, expect, it } from "vitest";

import { startAgentRun, type AgentRunner } from "../src/extension/agentRunner";
import type { HostToWebviewMessage } from "../src/shared/messages";

describe("startAgentRun", () => {
  it("posts every message produced by the runner", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const runner: AgentRunner = {
      run: async function* ({ runId, task }) {
        yield { type: "runStarted", runId, task };
        yield { type: "agentEvent", runId, message: "Working" };
        yield { type: "runFinished", runId };
      },
    };

    const handle = startAgentRun({
      task: "Inspect workspace",
      runner,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(handle.runId).toMatch(/^run-/);
    expect(postedMessages).toEqual([
      { type: "runStarted", runId: handle.runId, task: "Inspect workspace" },
      { type: "agentEvent", runId: handle.runId, message: "Working" },
      { type: "runFinished", runId: handle.runId },
    ]);
  });

  it("posts runFailed when the runner throws", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    const runner: AgentRunner = {
      run: async function* ({ runId, task }) {
        yield { type: "runStarted", runId, task };
        throw new Error("runtime exploded");
      },
    };

    const handle = startAgentRun({
      task: "Trigger failure",
      runner,
      postMessage: (message) => {
        postedMessages.push(message);
      },
    });

    await handle.done;

    expect(postedMessages).toEqual([
      { type: "runStarted", runId: handle.runId, task: "Trigger failure" },
      { type: "runFailed", runId: handle.runId, message: "runtime exploded" },
    ]);
  });

  it("passes an abort signal that is triggered by cancel", async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner: AgentRunner = {
      run: ({ runId, task, signal }) => {
        capturedSignal = signal;
        return (async function* () {
          yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
        })();
      },
    };

    const handle = startAgentRun({
      task: "Cancelable run",
      runner,
      postMessage: () => undefined,
    });

    handle.cancel();
    await handle.done;

    expect(capturedSignal?.aborted).toBe(true);
  });
});
