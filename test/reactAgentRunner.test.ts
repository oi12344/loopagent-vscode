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
          description: "Echo a test observation.",
          inputSchema: { type: "string" },
          invoke: async ({ input }: { input: unknown }) => `observed ${String(input)}`,
        },
      ],
      modelTurn: async ({ messages }) => {
        turn += 1;

        if (turn === 1) {
          return {
            kind: "toolRequests",
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "tool-1",
                  type: "function",
                  function: { name: "echoObservation", arguments: '"workspace"' },
                },
              ],
            },
            requests: [{ id: "tool-1", name: "echoObservation", rawArguments: '"workspace"', input: "workspace" }],
          };
        }

        expect(messages.slice(-2)).toEqual([
          expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ id: "tool-1" })] }),
          {
            role: "tool",
            requestId: "tool-1",
            name: "echoObservation",
            content: "observed workspace",
          },
        ]);
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

  it("prepends a runtime system prompt and continues when the provider fails", async () => {
    const seenMessages: unknown[] = [];
    const runner = createReactAgentRunner({
      systemPromptProvider: async ({ task }) => {
        if (task === "fallback") {
          throw new Error("runtime unavailable");
        }
        return "Use tools when repository facts are needed.";
      },
      modelTurn: async ({ messages }) => {
        seenMessages.push(messages);
        return { kind: "final", content: "done" };
      },
    });

    await collectRunnerMessages(runner, "normal");
    await collectRunnerMessages(runner, "fallback");

    expect(seenMessages).toEqual([
      [
        { role: "system", content: "Use tools when repository facts are needed." },
        { role: "user", content: "normal" },
      ],
      [{ role: "user", content: "fallback" }],
    ]);
  });

  it("does not expose test tools by default", async () => {
    const runner = createReactAgentRunner({
      modelTurn: async () => ({
        kind: "toolRequests",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: { name: "echoObservation", arguments: '"default tool"' },
            },
          ],
        },
        requests: [
          {
            id: "tool-1",
            name: "echoObservation",
            rawArguments: '"default tool"',
            input: "default tool",
          },
        ],
      }),
    });

    await expect(collectRunnerMessages(runner)).resolves.toContainEqual({
      type: "runFailed",
      runId: "run-1",
      message: "Unknown tool: echoObservation",
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
          description: "Echo a test observation.",
          inputSchema: { type: "string" },
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
