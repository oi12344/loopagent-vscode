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

async function collectRunnerMessagesInMode(runner: AgentRunner, mode: "ask" | "edit", task: string) {
  const messages: HostToWebviewMessage[] = [];
  for await (const message of runner.run({ runId: "run-1", task, mode, signal: new AbortController().signal })) {
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

  it("reports a completed outcome exactly once when the model finishes with no tool calls", async () => {
    const recordMemoryRunOutcome = vi.fn();
    const runner = createReactAgentRunner({
      recordMemoryRunOutcome,
      modelTurn: async () => ({ kind: "final", content: "Used observation." }),
    });

    await collectRunnerMessages(runner);

    expect(recordMemoryRunOutcome).toHaveBeenCalledTimes(1);
    expect(recordMemoryRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
        finalContent: "Used observation.",
        evidence: [],
      }),
    );
  });

  it("reports a failed outcome exactly once when the model requests an unknown tool", async () => {
    const recordMemoryRunOutcome = vi.fn();
    const runner = createReactAgentRunner({
      recordMemoryRunOutcome,
      modelTurn: async () => ({
        kind: "toolRequests",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tool-1", type: "function", function: { name: "missingTool", arguments: '"workspace"' } }],
        },
        requests: [{ id: "tool-1", name: "missingTool", rawArguments: '"workspace"', input: "workspace" }],
      }),
    });

    await collectRunnerMessages(runner);

    expect(recordMemoryRunOutcome).toHaveBeenCalledTimes(1);
    expect(recordMemoryRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", status: "failed", finalContent: undefined, evidence: [] }),
    );
  });

  it("reports a cancelled outcome exactly once when the run is already cancelled before starting", async () => {
    const controller = new AbortController();
    controller.abort();
    const recordMemoryRunOutcome = vi.fn();
    const runner = createReactAgentRunner({
      recordMemoryRunOutcome,
      modelTurn: async () => ({ kind: "final", content: "Should not run." }),
    });

    await collectRunnerMessages(runner, "Inspect workspace", controller.signal);

    expect(recordMemoryRunOutcome).toHaveBeenCalledTimes(1);
    expect(recordMemoryRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", status: "cancelled", finalContent: undefined, evidence: [] }),
    );
  });

  it("reports a cancelled outcome exactly once when the run is cancelled mid-execution", async () => {
    const controller = new AbortController();
    const recordMemoryRunOutcome = vi.fn();
    const invoke = vi.fn(async () => "unused");
    const runner = createReactAgentRunner({
      recordMemoryRunOutcome,
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          isConcurrencySafe: () => true,
          invoke,
        },
      ],
      modelTurn: async () => ({
        kind: "toolRequests",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tool-1", type: "function", function: { name: "exploreCode", arguments: '{"query":"first"}' } },
            { id: "tool-2", type: "function", function: { name: "exploreCode", arguments: '{"query":"second"}' } },
          ],
        },
        requests: [
          { id: "tool-1", name: "exploreCode", rawArguments: '{"query":"first"}', input: { query: "first" } },
          { id: "tool-2", name: "exploreCode", rawArguments: '{"query":"second"}', input: { query: "second" } },
        ],
      }),
    });
    const iterator = runner.run({ runId: "run-1", task: "Inspect workspace", signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    controller.abort();
    await iterator.next();

    expect(recordMemoryRunOutcome).toHaveBeenCalledTimes(1);
    expect(recordMemoryRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", status: "cancelled", finalContent: undefined, evidence: [] }),
    );
  });

  it("runs a requested tool and sends its observation to the next model turn", async () => {
    let turn = 0;
    const recordMemoryRunOutcome = vi.fn();
    const fileEvidence = { filePath: "src/example.ts", startLine: 1, endLine: 2, sha256: "abc123", required: true };
    const runner = createReactAgentRunner({
      recordMemoryRunOutcome,
      tools: [
        {
          name: "echoObservation",
          description: "Echo a test observation.",
          inputSchema: { type: "string" },
          invoke: async ({ input }: { input: unknown }) => ({
            content: `observed ${String(input)}`,
            evidence: [fileEvidence],
          }),
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

    expect(recordMemoryRunOutcome).toHaveBeenCalledTimes(1);
    expect(recordMemoryRunOutcome).toHaveBeenCalledWith({
      runId: "run-1",
      task: "Inspect workspace",
      status: "completed",
      finalContent: "Used observation.",
      evidence: [fileEvidence],
    });
  });

  it("runs each exploreCode request and pairs its real observation", async () => {
    let turn = 0;
    let followUpMessages: unknown[] = [];
    const invoke = vi.fn(async ({ input }) => `${(input as { query: string }).query} context`);
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
          isConcurrencySafe: () => true,
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

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(otherInvoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: { query: "first" },
        request: expect.objectContaining({ id: "tool-1" }),
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: { query: "second" },
        request: expect.objectContaining({ id: "tool-2" }),
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
        content: "second context",
      },
      {
        role: "tool",
        requestId: "tool-3",
        name: "echoObservation",
        content: "other context",
      },
    ]);
    expect(messages.some((message) => message.type === "agentEvent" && message.message.includes("Combined"))).toBe(false);
  });

  it("executes ten same-name safe tool requests", async () => {
    let turn = 0;
    let followUpMessages: unknown[] = [];
    const queries = Array.from({ length: 10 }, (_, index) => `query-${index + 1}`);
    const invoke = vi.fn(async ({ input }) => `${(input as { query: string }).query} context`);
    const toolCalls = queries.map((query, index) => ({
      id: `tool-${index + 1}`,
      type: "function" as const,
      function: { name: "exploreCode", arguments: JSON.stringify({ query }) },
    }));
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          isConcurrencySafe: () => true,
          invoke,
        },
      ],
      modelTurn: async ({ messages }) => {
        turn += 1;
        if (turn > 1) {
          followUpMessages = messages;
          return { kind: "final", content: "Used all contexts." };
        }

        return {
          kind: "toolRequests",
          assistantMessage: { role: "assistant", content: "", toolCalls },
          requests: queries.map((query, index) => ({
            id: `tool-${index + 1}`,
            name: "exploreCode",
            rawArguments: JSON.stringify({ query }),
            input: { query },
          })),
        };
      },
    });

    await collectRunnerMessages(runner);

    expect(invoke).toHaveBeenCalledTimes(10);
    expect(invoke).toHaveBeenNthCalledWith(
      10,
      expect.objectContaining({
        input: { query: "query-10" },
        request: expect.objectContaining({ id: "tool-10" }),
      }),
    );
    expect(followUpMessages.slice(-11)).toEqual([
      { role: "assistant", content: "", toolCalls },
      ...queries.map((query, index) => ({
        role: "tool",
        requestId: `tool-${index + 1}`,
        name: "exploreCode",
        content: `${query} context`,
      })),
    ]);
  });

  it("runs consecutive safe requests concurrently", async () => {
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async ({ request }) => {
      starts.push(request.id);
      await gate;
      return `${request.id} context`;
    });
    let turn = 0;
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          isConcurrencySafe: () => true,
          invoke,
        },
      ],
      modelTurn: async () => {
        turn += 1;
        if (turn > 1) return { kind: "final", content: "Used both contexts." };
        return {
          kind: "toolRequests",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "tool-1", type: "function", function: { name: "exploreCode", arguments: '{"query":"first"}' } },
              { id: "tool-2", type: "function", function: { name: "exploreCode", arguments: '{"query":"second"}' } },
            ],
          },
          requests: [
            { id: "tool-1", name: "exploreCode", rawArguments: '{"query":"first"}', input: { query: "first" } },
            { id: "tool-2", name: "exploreCode", rawArguments: '{"query":"second"}', input: { query: "second" } },
          ],
        };
      },
    });

    const run = collectRunnerMessages(runner);
    await vi.waitFor(() => expect(starts).toEqual(["tool-1", "tool-2"]));
    release();

    await expect(run).resolves.toContainEqual({ type: "runFinished", runId: "run-1" });
  });

  it("runs requests without a concurrency declaration serially", async () => {
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async ({ request }) => {
      starts.push(request.id);
      if (request.id === "tool-1") await gate;
      return `${request.id} context`;
    });
    let turn = 0;
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "writeObservation",
          description: "Write a test observation.",
          inputSchema: { type: "string" },
          invoke,
        },
      ],
      modelTurn: async () => {
        turn += 1;
        if (turn > 1) return { kind: "final", content: "Used both contexts." };
        return {
          kind: "toolRequests",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "tool-1", type: "function", function: { name: "writeObservation", arguments: '"first"' } },
              { id: "tool-2", type: "function", function: { name: "writeObservation", arguments: '"second"' } },
            ],
          },
          requests: [
            { id: "tool-1", name: "writeObservation", rawArguments: '"first"', input: "first" },
            { id: "tool-2", name: "writeObservation", rawArguments: '"second"', input: "second" },
          ],
        };
      },
    });

    const run = collectRunnerMessages(runner);
    await vi.waitFor(() => expect(starts).toEqual(["tool-1"]));
    release();
    await run;

    expect(starts).toEqual(["tool-1", "tool-2"]);
  });

  it("forwards model reasoning before the final answer", async () => {
    const runner = createReactAgentRunner({
      modelTurn: async () => ({
        kind: "final",
        reasoning: "Checking the relevant condition.",
        content: "Workspace is ready.",
      }),
    });

    await expect(collectRunnerMessages(runner)).resolves.toContainEqual({
      type: "assistantReasoningDelta",
      runId: "run-1",
      content: "Checking the relevant condition.",
    });
  });

  it("waits for readFile before applying an edit from the same model step", async () => {
    const order: string[] = [];
    let turn = 0;
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "readFile",
          description: "Read a file.",
          inputSchema: { type: "object" },
          isConcurrencySafe: () => true,
          invoke: async () => {
            order.push("read");
            return "before";
          },
        },
        {
          name: "applyEdit",
          description: "Apply an edit.",
          inputSchema: { type: "object" },
          invoke: async () => {
            expect(order).toEqual(["read"]);
            order.push("edit");
            return "Changes were applied.";
          },
        },
      ],
      modelTurn: async () => {
        turn += 1;
        if (turn > 1) return { kind: "final", content: "Done." };
        return {
          kind: "toolRequests",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "read-1", type: "function", function: { name: "readFile", arguments: '{"path":"src/example.ts"}' } },
              { id: "edit-1", type: "function", function: { name: "applyEdit", arguments: '{"changes":[]}' } },
            ],
          },
          requests: [
            { id: "read-1", name: "readFile", rawArguments: '{"path":"src/example.ts"}', input: { path: "src/example.ts" } },
            { id: "edit-1", name: "applyEdit", rawArguments: '{"changes":[]}', input: { changes: [] } },
          ],
        };
      },
    });

    await expect(collectRunnerMessages(runner)).resolves.toContainEqual({ type: "runFinished", runId: "run-1" });
    expect(order).toEqual(["read", "edit"]);
  });

  it("requires readFile and applyEdit before finishing an Edit-mode task", async () => {
    const choices: unknown[] = [];
    const order: string[] = [];
    let finalMessages: unknown;
    let turn = 0;
    const runner = createReactAgentRunner({
      maxSteps: 2,
      systemPromptProvider: () => "system context",
      tools: [
        {
          name: "readFile",
          description: "Read a file.",
          inputSchema: { type: "object" },
          invoke: async () => {
            order.push("read");
            return "before";
          },
        },
        {
          name: "applyEdit",
          description: "Preview an edit.",
          inputSchema: { type: "object" },
          invoke: async () => {
            order.push("review");
            return "Changes were applied.";
          },
        },
      ],
      modelTurn: async ({ messages, toolChoice }) => {
        choices.push(toolChoice);
        turn += 1;
        if (turn === 1) {
          return {
            kind: "toolRequests",
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "read-1", type: "function", function: { name: "readFile", arguments: '{"path":"src/example.ts"}' } },
              ],
            },
            requests: [{ id: "read-1", name: "readFile", rawArguments: '{"path":"src/example.ts"}', input: { path: "src/example.ts" } }],
          };
        }
        if (turn === 2) {
          return {
            kind: "toolRequests",
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "edit-1", type: "function", function: { name: "applyEdit", arguments: '{"changes":[]}' } },
              ],
            },
            requests: [{ id: "edit-1", name: "applyEdit", rawArguments: '{"changes":[]}', input: { changes: [] } }],
          };
        }
        finalMessages = messages;
        return { kind: "final", content: "Changes were applied." };
      },
    });

    const messages = await collectRunnerMessagesInMode(runner, "edit", "每个方法添加日志");

    expect(choices).toEqual([
      { type: "function", function: { name: "readFile" } },
      { type: "function", function: { name: "applyEdit" } },
      "none",
    ]);
    expect(order).toEqual(["read", "review"]);
    expect(finalMessages).toEqual([
      { role: "system", content: "system context" },
      { role: "user", content: "每个方法添加日志" },
      {
        role: "user",
        content: "编辑审阅结果：Changes were applied.\n请用中文思考，并用与原始任务相同的语言简洁汇报最终结果。",
      },
    ]);
    expect(messages).toContainEqual({ type: "assistantDelta", runId: "run-1", content: "Changes were applied." });
  });

  it("returns known tool errors to the model and retries applyEdit", async () => {
    const choices: unknown[] = [];
    let turn = 0;
    let applyAttempts = 0;
    const runner = createReactAgentRunner({
      maxSteps: 4,
      tools: [
        { name: "readFile", description: "Read.", inputSchema: {}, invoke: async () => "before" },
        {
          name: "applyEdit",
          description: "Review.",
          inputSchema: {},
          invoke: async () => {
            applyAttempts += 1;
            if (applyAttempts === 1) throw new Error("oldText must match exactly once");
            return "Changes were applied.";
          },
        },
      ],
      modelTurn: async ({ messages, toolChoice }) => {
        choices.push(toolChoice);
        turn += 1;
        if (turn === 1) return toolRequest("read-1", "readFile", { path: "src/example.ts" });
        if (turn === 2) {
          return {
            kind: "toolRequests",
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "edit-invalid", type: "function", function: { name: "applyEdit", arguments: "{" } }],
            },
            requests: [{
              id: "edit-invalid",
              name: "applyEdit",
              rawArguments: "{",
              input: undefined,
              parseError: "Invalid JSON arguments for tool applyEdit",
            }],
          } as const;
        }
        if (turn === 3) {
          expect(messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("Invalid JSON arguments") });
          return toolRequest("edit-1", "applyEdit", { changes: [] });
        }
        if (turn === 4) {
          expect(messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("oldText must match") });
          return toolRequest("edit-2", "applyEdit", { changes: [] });
        }
        return { kind: "final", content: "Changes were applied." };
      },
    });

    const messages = await collectRunnerMessagesInMode(runner, "edit", "修改文件");

    expect(choices).toEqual([
      { type: "function", function: { name: "readFile" } },
      "required",
      "required",
      { type: "function", function: { name: "applyEdit" } },
      "none",
    ]);
    expect(applyAttempts).toBe(2);
    expect(messages.some((message) => message.type === "runFailed")).toBe(false);
  });

  it("reports the last applyEdit error when review retries are exhausted", async () => {
    let turn = 0;
    const runner = createReactAgentRunner({
      maxSteps: 2,
      tools: [
        { name: "readFile", description: "Read.", inputSchema: {}, invoke: async () => "before" },
        { name: "applyEdit", description: "Review.", inputSchema: {}, invoke: async () => {
          throw new Error("oldText must match exactly once");
        } },
      ],
      modelTurn: async () => {
        turn += 1;
        return turn === 1
          ? toolRequest("read-1", "readFile", { path: "src/example.ts" })
          : toolRequest(`edit-${turn}`, "applyEdit", { changes: [] });
      },
    });

    await expect(collectRunnerMessagesInMode(runner, "edit", "修改文件")).resolves.toContainEqual({
      type: "runFailed",
      runId: "run-1",
      message: "Tool error: oldText must match exactly once",
    });
  });

  it("fails before invoking more than ten tool requests", async () => {
    const queries = Array.from({ length: 11 }, (_, index) => `query-${index + 1}`);
    const invoke = vi.fn(async () => "unused");
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          isConcurrencySafe: () => true,
          invoke,
        },
      ],
      modelTurn: async () => ({
        kind: "toolRequests",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: queries.map((query, index) => ({
            id: `tool-${index + 1}`,
            type: "function" as const,
            function: { name: "exploreCode", arguments: JSON.stringify({ query }) },
          })),
        },
        requests: queries.map((query, index) => ({
          id: `tool-${index + 1}`,
          name: "exploreCode",
          rawArguments: JSON.stringify({ query }),
          input: { query },
        })),
      }),
    });

    await expect(collectRunnerMessages(runner)).resolves.toContainEqual({
      type: "runFailed",
      runId: "run-1",
      message: "Too many tool requests in one step: 11",
    });
    expect(invoke).not.toHaveBeenCalled();
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

  it("does not start a safe batch after cancellation", async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async () => "unused");
    const runner = createReactAgentRunner({
      tools: [
        {
          name: "exploreCode",
          description: "Search code.",
          inputSchema: { type: "object" },
          isConcurrencySafe: () => true,
          invoke,
        },
      ],
      modelTurn: async () => ({
        kind: "toolRequests",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tool-1", type: "function", function: { name: "exploreCode", arguments: '{"query":"first"}' } },
            { id: "tool-2", type: "function", function: { name: "exploreCode", arguments: '{"query":"second"}' } },
          ],
        },
        requests: [
          { id: "tool-1", name: "exploreCode", rawArguments: '{"query":"first"}', input: { query: "first" } },
          { id: "tool-2", name: "exploreCode", rawArguments: '{"query":"second"}', input: { query: "second" } },
        ],
      }),
    });
    const iterator = runner.run({ runId: "run-1", task: "Inspect workspace", signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({
      value: { type: "agentEvent", runId: "run-1", message: "Running tool exploreCode (step 1, call 1): first" },
      done: false,
    });
    controller.abort();

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(invoke).not.toHaveBeenCalled();
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

function toolRequest(id: string, name: string, input: unknown) {
  const rawArguments = JSON.stringify(input);
  return {
    kind: "toolRequests" as const,
    assistantMessage: {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id, type: "function" as const, function: { name, arguments: rawArguments } }],
    },
    requests: [{ id, name, rawArguments, input }],
  };
}
