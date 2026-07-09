import { describe, expect, it } from "vitest";
import { createReactAgentRunner } from "../src/extension/agent/reactAgentRunner";
import type { AgentRunner } from "../src/extension/agentRunner";
import type { HostToWebviewMessage } from "../src/shared/messages";

async function collectRunnerMessages(
  runner: AgentRunner,
  task = "Inspect workspace",
  signal = new AbortController().signal,
): Promise<HostToWebviewMessage[]> {
  const messages: HostToWebviewMessage[] = [];

  for await (const message of runner.run({ runId: "run-1", task, signal })) {
    messages.push(message);
  }

  return messages;
}

describe("createReactAgentRunner", () => {
  it("finishes when the model returns a final answer", async () => {
    const runner = createReactAgentRunner({
      modelTurn: async () => ({ kind: "final", content: "Workspace is ready." }),
    });

    await expect(collectRunnerMessages(runner)).resolves.toEqual([
      { type: "runStarted", runId: "run-1", task: "Inspect workspace" },
      { type: "assistantStarted", runId: "run-1", provider: "ReAct Agent" },
      { type: "assistantThinking", runId: "run-1", message: "Planning step 1" },
      { type: "assistantDelta", runId: "run-1", content: "Workspace is ready." },
      { type: "runFinished", runId: "run-1" },
    ]);
  });

  it("runs a requested tool and sends its observation to the next model turn", async () => {
    let turn = 0;
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "echoObservation",
          invoke: async ({ input }: { input: unknown }) => `observed ${String(input)}`,
        },
      ],
      modelTurn: async ({ messages }) => {
        turn += 1;

        if (turn === 1) {
          return {
            kind: "toolRequests",
            requests: [{ id: "tool-1", name: "echoObservation", input: "workspace" }],
          };
        }

        expect(messages).toContainEqual({
          role: "tool",
          requestId: "tool-1",
          name: "echoObservation",
          content: "observed workspace",
        });
        return { kind: "final", content: "Used observation." };
      },
    });

    await expect(collectRunnerMessages(runner)).resolves.toEqual([
      { type: "runStarted", runId: "run-1", task: "Inspect workspace" },
      { type: "assistantStarted", runId: "run-1", provider: "ReAct Agent" },
      { type: "assistantThinking", runId: "run-1", message: "Planning step 1" },
      { type: "agentEvent", runId: "run-1", message: "Running tool echoObservation" },
      { type: "assistantThinking", runId: "run-1", message: "Planning step 2" },
      { type: "assistantDelta", runId: "run-1", content: "Used observation." },
      { type: "runFinished", runId: "run-1" },
    ]);
  });

  it("provides the default read-only echoObservation tool", async () => {
    let turn = 0;
    const runner = createReactAgentRunner({
      modelTurn: async ({ messages }) => {
        turn += 1;

        if (turn === 1) {
          return {
            kind: "toolRequests",
            requests: [{ id: "tool-1", name: "echoObservation", input: "default tool" }],
          };
        }

        expect(messages).toContainEqual({
          role: "tool",
          requestId: "tool-1",
          name: "echoObservation",
          content: "default tool",
        });
        return { kind: "final", content: "Default tool worked." };
      },
    });

    await expect(collectRunnerMessages(runner)).resolves.toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "Default tool worked.",
    });
  });

  it("fails when the model requests an unknown tool", async () => {
    const runner = createReactAgentRunner({
      modelTurn: async () => ({
        kind: "toolRequests",
        requests: [{ id: "tool-1", name: "missingTool", input: "workspace" }],
      }),
    });

    await expect(collectRunnerMessages(runner)).resolves.toEqual([
      { type: "runStarted", runId: "run-1", task: "Inspect workspace" },
      { type: "assistantStarted", runId: "run-1", provider: "ReAct Agent" },
      { type: "assistantThinking", runId: "run-1", message: "Planning step 1" },
      { type: "agentEvent", runId: "run-1", message: "Running tool missingTool" },
      { type: "runFailed", runId: "run-1", message: "Unknown tool: missingTool" },
    ]);
  });

  it("fails after reaching the maximum number of ReAct steps", async () => {
    const runner = createReactAgentRunner({
      maxSteps: 2,
      tools: [
        {
          name: "echoObservation",
          invoke: async ({ input }: { input: unknown }) => `observed ${String(input)}`,
        },
      ],
      modelTurn: async () => ({
        kind: "toolRequests",
        requests: [{ id: "tool-1", name: "echoObservation", input: "workspace" }],
      }),
    });

    await expect(collectRunnerMessages(runner)).resolves.toEqual([
      { type: "runStarted", runId: "run-1", task: "Inspect workspace" },
      { type: "assistantStarted", runId: "run-1", provider: "ReAct Agent" },
      { type: "assistantThinking", runId: "run-1", message: "Planning step 1" },
      { type: "agentEvent", runId: "run-1", message: "Running tool echoObservation" },
      { type: "assistantThinking", runId: "run-1", message: "Planning step 2" },
      { type: "agentEvent", runId: "run-1", message: "Running tool echoObservation" },
      { type: "runFailed", runId: "run-1", message: "Reached max ReAct steps: 2" },
    ]);
  });

  it("does not call the model when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let calledModel = false;
    const runner = createReactAgentRunner({
      modelTurn: async () => {
        calledModel = true;
        return { kind: "final", content: "Should not run." };
      },
    });

    await expect(collectRunnerMessages(runner, "Inspect workspace", controller.signal)).resolves.toEqual([]);
    expect(calledModel).toBe(false);
  });
});
