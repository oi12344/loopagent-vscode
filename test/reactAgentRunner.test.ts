import { describe, expect, it, vi } from "vitest";
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

  it("executes distinct tools once and pairs duplicate requests", async () => {
    let turn = 0;
    let followUpMessages: unknown[] = [];
    const invoke = vi.fn(async () => "first context");
    const otherInvoke = vi.fn(async () => "other context");
    const toolCalls = [
      {
        id: "tool-1",
        type: "function" as const,
        function: { name: "exploreCode", arguments: '{"query":"first"}' },
      },
      {
        id: "tool-2",
        type: "function" as const,
        function: { name: "exploreCode", arguments: '{"query":"second"}' },
      },
      {
        id: "tool-3",
        type: "function" as const,
        function: { name: "echoObservation", arguments: '"third"' },
      },
    ];
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          invoke,
        },
        {
          name: "echoObservation",
          description: "Echo an observation.",
          inputSchema: { type: "string" },
          invoke: otherInvoke,
        },
      ],
      modelTurn: async ({ messages }) => {
        turn += 1;
        if (turn > 1) {
          followUpMessages = messages;
          return { kind: "final", content: "Used one search per step." };
        }

        return {
          kind: "toolRequests",
          assistantMessage: { role: "assistant", content: "", toolCalls },
          requests: [
            {
              id: "tool-1",
              name: "exploreCode",
              rawArguments: '{"query":"first"}',
              input: { query: "first" },
            },
            {
              id: "tool-2",
              name: "exploreCode",
              rawArguments: '{"query":"second"}',
              input: { query: "second" },
            },
            {
              id: "tool-3",
              name: "echoObservation",
              rawArguments: '"third"',
              input: "third",
            },
          ],
        };
      },
    });

    const messages = await collectRunnerMessages(runner);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(otherInvoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { query: "first" },
        request: expect.objectContaining({ id: "tool-1" }),
      }),
    );
    expect(followUpMessages.slice(-4)).toEqual([
      { role: "assistant", content: "", toolCalls },
      {
        role: "tool",
        requestId: "tool-1",
        name: "exploreCode",
        content: "first context",
      },
      {
        role: "tool",
        requestId: "tool-2",
        name: "exploreCode",
        content:
          "Tool exploreCode was skipped because each tool can run only once per step. Review the earlier observation before requesting it again in a later step.",
      },
      {
        role: "tool",
        requestId: "tool-3",
        name: "echoObservation",
        content: "other context",
      },
    ]);
    expect(messages).toContainEqual({
      type: "agentEvent",
      runId: "run-1",
      message: "Skipped duplicate tool exploreCode (step 1, call 2)",
    });
  });

  it("reports distinct and safe exploreCode progress for every call", async () => {
    let turn = 0;
    const query = `${"x".repeat(100)}  \n ${"y".repeat(100)}`;
    const queryPreview = `${"x".repeat(100)} ${"y".repeat(99)}`;
    const queries = [
      query,
      query,
      "inspect E:\\secret\\source.ts",
      "inspect \\\\server\\share\\source.ts",
      "path=/home/user/source.ts",
      "inspect(/etc/passwd)",
      "inspect /@scope/package.json",
      "inspect /用户/项目/文件.ts",
      "api_key=sk-1234567890",
      "access_token=value",
    ];
    const expectedPreviews = [
      queryPreview,
      queryPreview,
      ...Array.from({ length: queries.length - 2 }, () => "<sensitive query hidden>"),
    ];
    const runner = createReactAgentRunner({
      maxSteps: queries.length + 1,
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          invoke: async () => "code context",
        },
      ],
      modelTurn: async () => {
        turn += 1;
        const currentQuery = queries[turn - 1];
        if (!currentQuery) return { kind: "final", content: "Used code context." };

        return {
          kind: "toolRequests",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: `tool-${turn}`,
                type: "function" as const,
                function: { name: "exploreCode", arguments: JSON.stringify({ query: currentQuery }) },
              },
            ],
          },
          requests: [
            {
              id: `tool-${turn}`,
              name: "exploreCode",
              rawArguments: JSON.stringify({ query: currentQuery }),
              input: { query: currentQuery },
            },
          ],
        };
      },
    });

    const messages = await collectRunnerMessages(runner);

    expect(messages.filter((message) => message.type === "agentEvent")).toEqual(
      expectedPreviews.flatMap((preview, index) => {
        const step = index + 1;
        return [
          {
            type: "agentEvent",
            runId: "run-1",
            message: `Running tool exploreCode (step ${step}, call 1): ${preview}`,
          },
          {
            type: "agentEvent",
            runId: "run-1",
            message: `Tool exploreCode returned (step ${step}, call 1): 12 chars`,
          },
        ];
      }),
    );
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
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: { name: "missingTool", arguments: '"workspace"' },
            },
          ],
        },
        requests: [
          { id: "tool-1", name: "missingTool", rawArguments: '"workspace"', input: "workspace" },
        ],
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

  it("forces a final answer after reaching the maximum tool steps", async () => {
    let toolTurn = 0;
    const choices: Array<"auto" | "none" | undefined> = [];
    const invoke = vi.fn(async () => "observed workspace");
    const runner = createReactAgentRunner({
      maxSteps: 2,
      tools: [
        {
          name: "echoObservation",
          description: "Echo a test observation.",
          inputSchema: { type: "string" },
          invoke,
        },
      ],
      modelTurn: async ({ toolChoice }) => {
        choices.push(toolChoice);
        if (toolChoice === "none") {
          return { kind: "final", content: "Best supported answer with limitations." };
        }
        toolTurn += 1;
        const id = `tool-${toolTurn}`;
        return {
          kind: "toolRequests",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id, type: "function", function: { name: "echoObservation", arguments: '"workspace"' } }],
          },
          requests: [{ id, name: "echoObservation", rawArguments: '"workspace"', input: "workspace" }],
        };
      },
    });

    const messages = await collectRunnerMessages(runner);

    expect(choices).toEqual(["auto", "auto", "none"]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(messages).toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "Best supported answer with limitations.",
    });
    expect(messages.at(-1)).toEqual({ type: "runFinished", runId: "run-1" });
    expect(messages.some((message) => message.type === "runFailed")).toBe(false);
  });

  it("rejects tool requests during the default final answer step", async () => {
    const choices: Array<"auto" | "none" | undefined> = [];
    const invoke = vi.fn(async () => "code context");
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          invoke,
        },
      ],
      modelTurn: async ({ toolChoice }) => {
        choices.push(toolChoice);
        const step = choices.length;
        const id = `tool-${step}`;
        const rawArguments = JSON.stringify({ query: `step ${step}` });
        return {
          kind: "toolRequests",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id, type: "function", function: { name: "exploreCode", arguments: rawArguments } }],
          },
          requests: [{ id, name: "exploreCode", rawArguments, input: { query: `step ${step}` } }],
        };
      },
    });

    const messages = await collectRunnerMessages(runner);

    expect(choices).toEqual(["auto", "auto", "auto", "none"]);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(messages).not.toContainEqual({
      type: "agentEvent",
      runId: "run-1",
      message: "Running tool exploreCode (step 4, call 1): step 4",
    });
    expect(messages.at(-1)).toEqual({
      type: "runFailed",
      runId: "run-1",
      message: "Model requested tools during the final answer step",
    });
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
