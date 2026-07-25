import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { VsCodeWorkspaceApi } from "../src/extension/intelligence/vscodeWorkspaceIntelligence";
import type { ModelMessage, ModelProvider } from "../src/extension/model/types";
import type { HostToWebviewMessage } from "../src/shared/messages";

describe("createConfiguredAgentRunner code intelligence context", () => {
  it("creates the React runner without legacy Superpowers resources", async () => {
    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({ provider: "deepseek", model: "test-model", baseUrl: "", apiKey: "test-key", thinking: "disabled" }),
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({ id: "mock", displayName: "Mock model", stream: async function* () { yield { type: "contentDelta", content: "ask works" }; } }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence: { buildCodeIntelligencePrompt: async () => "" } } as never,
    );

    await expect(collectHostMessages(runner, "Explain this code")).resolves.toContainEqual({
      type: "assistantDelta", runId: "run-1", content: "ask works",
    });
  });

  it("runs native exploreCode tool calls and returns observations to the next model turn", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "代码语义索引上下文\nsrc/modelAccess.ts"),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "runtime context",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* ({ messages }) {
          capturedMessages.push(messages);
          if (capturedMessages.length === 1) {
            yield {
              type: "toolCallDelta",
              index: 0,
              id: "call_1",
              name: "exploreCode",
              argumentsDelta: '{"query":"provider registry model context"}',
            };
            yield { type: "finishReason", reason: "tool_calls" };
            return;
          }

          yield { type: "contentDelta", content: "providerRegistry 负责接入代码上下文。" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner: AgentRunner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence },
    );

    const hostMessages = await collectHostMessages(runner, "谁负责把代码上下文加入模型请求？");

    const systemPrompt = capturedMessages[0]!
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    expect(systemPrompt).toContain("runtime context");
    expect(systemPrompt).toContain("exploreCode");
    expect(systemPrompt).toContain("current production entry points");
    expect(systemPrompt).toContain("verify every claimed call edge");
    expect(systemPrompt).toContain(
      "If the available source evidence is sufficient, answer immediately without calling another tool.",
    );
    expect(systemPrompt).toContain(
      "Only call exploreCode again for a concrete missing fact required to answer the user",
    );
    expect(systemPrompt).toContain("does not overlap previous queries");
    expect(systemPrompt).toContain("When separate read-only searches are needed");
    expect(systemPrompt).toContain("Do not request an exact duplicate search");
    expect(systemPrompt).not.toContain("代码语义索引上下文");
    expect(workspaceIntelligence.buildCodeIntelligencePrompt).toHaveBeenCalledTimes(1);
    expect(workspaceIntelligence.buildCodeIntelligencePrompt).toHaveBeenCalledWith("provider registry model context");
    expect(capturedMessages[1]!.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "exploreCode",
              arguments: '{"query":"provider registry model context"}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: "代码语义索引上下文\nsrc/modelAccess.ts",
        toolCallId: "call_1",
        name: "exploreCode",
      },
    ]);
    expect(hostMessages).toContainEqual({
      type: "toolCallStarted",
      runId: "run-1",
      callId: "1-1",
      toolName: "exploreCode",
      input: "provider registry model context",
    });
    expect(hostMessages).toContainEqual({
      type: "toolCallFinished",
      runId: "run-1",
      callId: "1-1",
      succeeded: true,
      output: "代码语义索引上下文\nsrc/modelAccess.ts",
    });
    expect(hostMessages).toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "providerRegistry 负责接入代码上下文。",
    });
  });

  it("returns read, edit and approved command observations to the model", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
    };
    const readFileTool: ReactAgentTool = {
      name: "readFile",
      description: "Read a file.",
      inputSchema: { type: "object" },
      isConcurrencySafe: () => true,
      invoke: vi.fn(async () => "const before = true;"),
    };
    const applyEditTool: ReactAgentTool = {
      name: "applyEdit",
      description: "Apply an edit.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "Changes were applied."),
    };
    const runCommandTool: ReactAgentTool = {
      name: "runCommand",
      description: "Run an approved command.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "Status: exited\nExit code: 0\nstdout:\ntypecheck passed\nstderr:\n"),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* ({ messages }) {
          capturedMessages.push(messages);
          if (capturedMessages.length === 1) {
            yield {
              type: "toolCallDelta",
              index: 0,
              id: "read-call",
              name: "readFile",
              argumentsDelta: '{"path":"src/example.ts"}',
            };
          } else if (capturedMessages.length === 2) {
            yield {
              type: "toolCallDelta",
              index: 0,
              id: "apply-call",
              name: "applyEdit",
              argumentsDelta:
                '{"changes":[{"kind":"replace","path":"src/example.ts","oldText":"before","newText":"after"}]}',
            };
          } else if (capturedMessages.length === 3) {
            yield {
              type: "toolCallDelta",
              index: 0,
              id: "command-call",
              name: "runCommand",
              argumentsDelta: '{"command":"npm run typecheck"}',
            };
          } else {
            yield { type: "contentDelta", content: "Edit applied and verified." };
          }
          yield { type: "finishReason", reason: capturedMessages.length < 4 ? "tool_calls" : "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence, readFileTool, applyEditTool, runCommandTool },
    );

    await expect(collectHostMessages(runner, "Rename the constant.")).resolves.toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "Edit applied and verified.",
    });

    const systemPrompt = capturedMessages[0]!
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    expect(systemPrompt).toContain("Before editing, read the relevant file content with readFile.");
    expect(systemPrompt).toContain(
      "For non-local changes, public behavior changes, or unclear conventions, first use exploreCode to find the closest existing implementation.",
    );
    expect(systemPrompt).toContain(
      "Read that implementation, its direct callers, relevant types or data definitions, and tests before applying changes.",
    );
    expect(systemPrompt).toContain("Skip this exploration for clearly scoped single-file changes.");
    expect(systemPrompt).toContain("Propose all workspace changes only through applyEdit.");
    expect(systemPrompt).toContain("After reading the relevant files, call applyEdit immediately with the complete change proposal.");
    expect(systemPrompt).toContain(
      "Do not ask the user for textual confirmation before calling applyEdit; applyEdit opens the review interface and handles confirmation.",
    );
    expect(systemPrompt).toContain("Do not claim an edit succeeded until applyEdit reports that it was applied.");
    expect(systemPrompt).toContain("Use runCommand when tests, type checks, or builds are relevant to verify a change.");
    expect(systemPrompt).toContain("If the user rejects a command, do not request the same command again.");
    expect(readFileTool.invoke).toHaveBeenCalledTimes(1);
    expect(applyEditTool.invoke).toHaveBeenCalledTimes(1);
    expect(runCommandTool.invoke).toHaveBeenCalledTimes(1);
    const allMessages = capturedMessages.flat();
    expect(allMessages.some((m) => m.role === "user" && m.content === "Rename the constant.")).toBe(true);
    expect(
      allMessages.some((m) => m.role === "assistant" && (m as any)?.toolCalls?.some((c: any) => c.function.name === "readFile")),
    ).toBe(true);
    expect(
      allMessages.some((m) => m.role === "assistant" && (m as any)?.toolCalls?.some((c: any) => c.function.name === "applyEdit")),
    ).toBe(true);
    expect(allMessages).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "runCommand",
      content: expect.stringContaining("Exit code: 0"),
    }));
  });

  it("runs workflow subagents with routed base tools and streams their progress", async () => {
    const parentTurns: ModelMessage[][] = [];
    const childToolNames: string[][] = [];
    const onCheckpoint = vi.fn(async () => undefined);
    const projectMemory = {
      loadContext: vi.fn(async () => ({
        generation: 3,
        prompt: "",
        trace: { candidateCount: 0, includedIds: [], excluded: [] },
      })),
      recordOutcome: vi.fn(async () => undefined),
    };
    const inspectRepoTool: ReactAgentTool = {
      name: "inspectRepo",
      description: "Inspect repository files for a delegated task.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "inspection complete"),
    };
    const readFileTool: ReactAgentTool = {
      name: "readFile",
      description: "Read a file.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "file content"),
    };
    const applyEditTool: ReactAgentTool = {
      name: "applyEdit",
      description: "Apply an edit.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "edited"),
    };
    const runCommandTool: ReactAgentTool = {
      name: "runCommand",
      description: "Run a command.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "ran"),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* ({ messages, tools }) {
          const task = [...messages].reverse().find((message) => message.role === "user")?.content;
          const toolNames = (tools ?? []).map((tool) => tool.function.name);
          if (task === "Inspect the delegated repository task.") {
            childToolNames.push(toolNames);
            yield { type: "contentDelta", content: "child result" };
            yield { type: "finishReason", reason: "stop" };
            return;
          }

          parentTurns.push(messages);
          if (parentTurns.length === 1) {
            expect(toolNames).toEqual(expect.arrayContaining([
              "spawnSubagent", "waitForSubagents", "cancelSubagent", "applyEdit", "runCommand", "inspectRepo",
            ]));
            yield {
              type: "toolCallDelta",
              index: 0,
              id: "spawn-call",
              name: "spawnSubagent",
              argumentsDelta:
                '{"task":"Inspect the delegated repository task.","toolHints":["readFile"]}',
            };
            yield { type: "finishReason", reason: "tool_calls" };
            return;
          }
          if (parentTurns.length === 2) {
            yield {
              type: "toolCallDelta",
              index: 0,
              id: "wait-call",
              name: "waitForSubagents",
              argumentsDelta: '{"subagentIds":["subagent-1"]}',
            };
            yield { type: "finishReason", reason: "tool_calls" };
            return;
          }
          yield { type: "contentDelta", content: "parent done" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      {
        workspaceIntelligence: { buildCodeIntelligencePrompt: vi.fn(async () => "unused") },
        readFileTool,
        applyEditTool,
        runCommandTool,
        extraTools: [inspectRepoTool],
        onCheckpoint,
        projectMemory: projectMemory as never,
      },
    );

    const hostMessages = await collectHostMessages(runner, "Delegate this repository task.");

    expect(childToolNames).toEqual([["readFile"]]);
    expect(parentTurns.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        name: "waitForSubagents",
        content: expect.stringContaining('"content":"child result"'),
      }),
    ]));
    expect(hostMessages).toEqual(expect.arrayContaining([
      { type: "subagentStateChanged", runId: "run-1", agentId: "subagent-1", status: "pending" },
      { type: "subagentStateChanged", runId: "run-1", agentId: "subagent-1", status: "running" },
      { type: "subagentStateChanged", runId: "run-1", agentId: "subagent-1", status: "completed" },
      { type: "agentEvent", runId: "run-1", message: "[subagent-1] child result" },
      { type: "assistantDelta", runId: "run-1", content: "parent done" },
    ]));
    expect(hostMessages).not.toContainEqual({ type: "assistantDelta", runId: "run-1", content: "child result" });
    expect(onCheckpoint).toHaveBeenCalled();
    expect(onCheckpoint.mock.calls.every(([checkpoint]) => checkpoint.runId === "run-1")).toBe(true);
    expect(projectMemory.loadContext).toHaveBeenCalledTimes(1);
    expect(projectMemory.loadContext).toHaveBeenCalledWith("Delegate this repository task.");
    expect(projectMemory.recordOutcome).toHaveBeenCalledTimes(1);
    expect(projectMemory.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), 3);
  });

  it("uses the role system prompt for child runners", async () => {
    const childMessages: ModelMessage[][] = [];
    let parentTurn = 0;

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({ provider: "deepseek", model: "test-model", baseUrl: "", apiKey: "test-key", thinking: "disabled" }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* ({ messages }) {
          const task = [...messages].reverse().find((m) => m.role === "user")?.content;
          if (task === "Review the code.") {
            childMessages.push(messages);
            yield { type: "contentDelta", content: "reviewed" };
            yield { type: "finishReason", reason: "stop" };
            return;
          }
          parentTurn++;
          if (parentTurn === 1) {
            yield {
              type: "toolCallDelta", index: 0, id: "spawn-1", name: "spawnSubagent",
              argumentsDelta: '{"task":"Review the code.","role":"reviewer"}',
            };
            yield { type: "finishReason", reason: "tool_calls" };
            return;
          }
          if (parentTurn === 2) {
            yield {
              type: "toolCallDelta", index: 0, id: "wait-1", name: "waitForSubagents",
              argumentsDelta: '{"subagentIds":["subagent-1"]}',
            };
            yield { type: "finishReason", reason: "tool_calls" };
            return;
          }
          yield { type: "contentDelta", content: "done" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence: { buildCodeIntelligencePrompt: vi.fn(async () => "unused") } },
    );

    await collectHostMessages(runner, "Please review this code.");

    const childSystemPrompt = childMessages[0]
      ?.filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n") ?? "";

    expect(childSystemPrompt).toContain("reviewer role");
    expect(childSystemPrompt).toContain("defects");
    expect(childSystemPrompt).not.toContain("LoopAgent");
  });

  it("keeps workflow tools out when workflow support is disabled", async () => {
    const capturedToolNames: string[][] = [];
    const reportResultTool: ReactAgentTool = {
      name: "reportSubagentResult",
      description: "Report a structured subagent result.",
      inputSchema: { type: "object" },
      invoke: vi.fn(async () => "reported"),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({ provider: "deepseek", model: "test-model", baseUrl: "", apiKey: "test-key", thinking: "disabled" }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({ collectVsCodeRuntimeContext: async () => ({}) }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({ renderCodeRuntimeContextPrompt: () => "" }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* ({ tools }) {
          capturedToolNames.push((tools ?? []).map((tool) => tool.function.name));
          yield { type: "contentDelta", content: "reported" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      {
        workspaceIntelligence: { buildCodeIntelligencePrompt: vi.fn(async () => "unused") },
        extraTools: [reportResultTool],
        enableWorkflowTools: false,
      },
    );

    await collectHostMessages(runner, "Write the subagent report.");

    expect(capturedToolNames).toEqual([["exploreCode", "reportSubagentResult"]]);
  });

  it("cancels a deferred child in order when the parent finishes after spawning it", async () => {
    const fixture = createDeferredWorkflowProvider();
    mockDeferredWorkflowProvider(fixture.provider);

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence: { buildCodeIntelligencePrompt: vi.fn(async () => "unused") } },
    );

    const hostMessages = await collectHostMessages(runner, "Spawn a deferred child and finish.");
    const statuses = hostMessages
      .filter((message): message is Extract<HostToWebviewMessage, { type: "subagentStateChanged" }> =>
        message.type === "subagentStateChanged")
      .map((message) => message.status);

    expect(statuses).toEqual(["pending", "running", "cancelled"]);
    expect(fixture.childSignal()?.aborted).toBe(true);
    expect(fixture.childAbortCount()).toBe(1);
  }, 2_000);

  it("settles and aborts a deferred child when the parent signal is aborted", async () => {
    const fixture = createDeferredWorkflowProvider({ waitForParentAbort: true });
    mockDeferredWorkflowProvider(fixture.provider);

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence: { buildCodeIntelligencePrompt: vi.fn(async () => "unused") } },
    );
    const controller = new AbortController();
    const run = collectHostMessages(runner, "Spawn a deferred child and wait.", controller.signal);

    await fixture.childStarted;
    controller.abort();
    const hostMessages = await run;

    expect(fixture.childSignal()?.aborted).toBe(true);
    expect(fixture.childAbortCount()).toBe(1);
    expect(hostMessages
      .filter((message) => message.type === "subagentStateChanged")
      .map((message) => message.status))
      .toEqual(["pending", "running", "cancelled"]);
  }, 2_000);

  it("wires tree-sitter parser runtime into VS Code workspace intelligence", async () => {
    const fakeVsCodeApi = createFakeVsCodeWorkspaceApi("E:\\work\\repo", new Map());
    const fakeParserRuntime = {
      parse: vi.fn(),
    };
    const createTreeSitterParserRuntime = vi.fn(() => fakeParserRuntime);
    const createVsCodeWorkspaceIntelligence = vi.fn(() => ({
      buildCodeIntelligencePrompt: vi.fn(async () => ""),
      getStatus: vi.fn(() => "ready"),
      getDiagnostics: vi.fn(() => []),
    }));

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/intelligence/parser/treeSitterRuntime", () => ({
      createTreeSitterParserRuntime,
    }));
    vi.doMock("../src/extension/intelligence/vscodeWorkspaceIntelligence", () => ({
      createVsCodeWorkspaceIntelligence,
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* () {
          yield { type: "contentDelta", content: "ok" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    await createConfiguredAgentRunner({} as never, { provider: "deepseek" }, { vscodeApi: fakeVsCodeApi });

    expect(createTreeSitterParserRuntime).toHaveBeenCalledTimes(1);
    expect(createVsCodeWorkspaceIntelligence).toHaveBeenCalledWith(fakeVsCodeApi, { parserRuntime: fakeParserRuntime });
  });

  it("injects project memory context alongside the runtime prompt", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
    };
    const fakeProjectMemory = {
      loadContext: vi.fn(async (task: string) => ({
        generation: 7,
        prompt: `<project-memory-data trust="untrusted">\n[{"kind":"fact","subject":"build","content":"Use npm run compile.","sources":["user_confirmation"]}]\n</project-memory-data>`,
        trace: { candidateCount: 1, includedIds: [1], excluded: [] },
      })),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "runtime context",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* ({ messages }) {
          capturedMessages.push(messages);
          yield { type: "contentDelta", content: "ok" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence, projectMemory: fakeProjectMemory as never },
    );

    await collectHostMessages(runner, "how do I build this project");

    const systemPrompt = capturedMessages[0]!
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    expect(systemPrompt).toContain("runtime context");
    expect(systemPrompt).toContain("<project-memory-data");
    expect(systemPrompt).toContain("Use npm run compile.");
    expect(fakeProjectMemory.loadContext).toHaveBeenCalledWith("how do I build this project");
  });

  it("records the run outcome with the generation captured when memory context was loaded", async () => {
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
    };
    const fakeProjectMemory = {
      loadContext: vi.fn(async () => ({
        generation: 7,
        prompt: "",
        trace: { candidateCount: 0, includedIds: [], excluded: [] },
      })),
      recordOutcome: vi.fn(async () => undefined),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* () {
          yield { type: "contentDelta", content: "ok" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence, projectMemory: fakeProjectMemory as never },
    );

    await collectHostMessages(runner, "task");

    expect(fakeProjectMemory.recordOutcome).toHaveBeenCalledTimes(1);
    expect(fakeProjectMemory.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", status: "completed", finalContent: "ok" }),
      7,
    );
  });

  it("skips recordOutcome when no memory context generation was captured for the run", async () => {
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
    };
    const fakeProjectMemory = {
      loadContext: vi.fn(async () => {
        throw new Error("memory unavailable");
      }),
      recordOutcome: vi.fn(async () => undefined),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* () {
          yield { type: "contentDelta", content: "ok" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence, projectMemory: fakeProjectMemory as never },
    );

    await collectHostMessages(runner, "task");

    expect(fakeProjectMemory.recordOutcome).not.toHaveBeenCalled();
  });

  it("does not block a run when project memory loadContext fails", async () => {
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => "unused"),
    };
    const fakeProjectMemory = {
      loadContext: vi.fn(async () => {
        throw new Error("memory unavailable");
      }),
    };

    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "test-model",
        baseUrl: "",
        apiKey: "test-key",
        thinking: "disabled",
      }),
    }));
    vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
      collectVsCodeRuntimeContext: async () => ({}),
    }));
    vi.doMock("../src/extension/runtime/contextPrompt", () => ({
      renderCodeRuntimeContextPrompt: () => "",
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({
        id: "mock",
        displayName: "Mock model",
        stream: async function* () {
          yield { type: "contentDelta", content: "ok" };
          yield { type: "finishReason", reason: "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence, projectMemory: fakeProjectMemory as never },
    );

    await expect(collectHostMessages(runner, "task")).resolves.toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "ok",
    });
  });
});

async function collectHostMessages(
  runner: AgentRunner,
  task: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<HostToWebviewMessage[]> {
  const messages: HostToWebviewMessage[] = [];
  for await (const message of runner.run({
    runId: "run-1",
    task,
    signal,
  })) {
    messages.push(message);
  }
  return messages;
}

function createDeferredWorkflowProvider(options: { waitForParentAbort?: boolean } = {}) {
  let parentTurn = 0;
  let signal: AbortSignal | undefined;
  let abortCount = 0;
  let resolveChildStarted!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    resolveChildStarted = resolve;
  });
  const provider: ModelProvider = {
    id: "mock",
    displayName: "Mock model",
    stream: async function* ({ messages, signal: requestSignal }) {
      const task = [...messages].reverse().find((message) => message.role === "user")?.content;
      if (task === "Deferred child task.") {
        signal = requestSignal;
        resolveChildStarted();
        await waitForAbort(requestSignal, () => abortCount++);
        return;
      }

      parentTurn++;
      if (parentTurn === 1) {
        yield {
          type: "toolCallDelta",
          index: 0,
          id: "spawn-deferred-child",
          name: "spawnSubagent",
          argumentsDelta: '{"task":"Deferred child task."}',
        };
        yield { type: "finishReason", reason: "tool_calls" };
        return;
      }
      if (options.waitForParentAbort) {
        await waitForAbort(requestSignal);
        return;
      }
      yield { type: "contentDelta", content: "parent finished" };
      yield { type: "finishReason", reason: "stop" };
    },
  };
  return {
    provider,
    childStarted,
    childSignal: () => signal,
    childAbortCount: () => abortCount,
  };
}

function mockDeferredWorkflowProvider(provider: ModelProvider): void {
  vi.resetModules();
  vi.doMock("../src/extension/model/modelConfig", () => ({
    getModelRuntimeConfig: async () => ({
      provider: "deepseek",
      model: "test-model",
      baseUrl: "",
      apiKey: "test-key",
      thinking: "disabled",
    }),
  }));
  vi.doMock("../src/extension/runtime/vscodeRuntimeContext", () => ({
    collectVsCodeRuntimeContext: async () => ({}),
  }));
  vi.doMock("../src/extension/runtime/contextPrompt", () => ({
    renderCodeRuntimeContextPrompt: () => "",
  }));
  vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
    createDeepSeekProvider: () => provider,
  }));
}

function waitForAbort(signal: AbortSignal, onAbort?: () => void): Promise<void> {
  if (signal.aborted) {
    onAbort?.();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      onAbort?.();
      resolve();
    }, { once: true });
  });
}

function createFakeVsCodeWorkspaceApi(workspaceRoot: string, files: Map<string, string>): VsCodeWorkspaceApi {
  const uris = [...files.keys()].map((fsPath) => ({ fsPath }));

  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot }, name: "repo", index: 0 }],
      findFiles: async () => uris,
      fs: {
        readFile: async (uri: { fsPath: string }) => new TextEncoder().encode(files.get(uri.fsPath) ?? ""),
      },
      asRelativePath: (uriOrPath: { fsPath: string } | string) => {
        const fsPath = typeof uriOrPath === "string" ? uriOrPath : uriOrPath.fsPath;
        return fsPath.replace(workspaceRoot, "").replace(/^[/\\]/, "").replace(/\\/g, "/");
      },
    },
  };
}
