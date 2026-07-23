import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { VsCodeWorkspaceApi } from "../src/extension/intelligence/vscodeWorkspaceIntelligence";
import type { ModelMessage, ModelProvider } from "../src/extension/model/types";
import type { HostToWebviewMessage } from "../src/shared/messages";

describe("createConfiguredAgentRunner code intelligence context", () => {
  it("keeps Ask on the React runner when Superpowers resources are unavailable", async () => {
    vi.resetModules();
    vi.doMock("../src/extension/model/modelConfig", () => ({
      getModelRuntimeConfig: async () => ({ provider: "deepseek", model: "test-model", baseUrl: "", apiKey: "test-key", thinking: "disabled" }),
    }));
    vi.doMock("../src/extension/model/providers/deepseekProvider", () => ({
      createDeepSeekProvider: (): ModelProvider => ({ id: "mock", displayName: "Mock model", stream: async function* () { yield { type: "contentDelta", content: "ask works" }; } }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner({} as never, { provider: "deepseek" }, { superpowersResourceRoot: "E:\\missing-superpowers", workspaceIntelligence: { buildCodeIntelligencePrompt: async () => "" } } as never, "ask");

    await expect(collectHostMessages(runner, "Explain this code")).resolves.toContainEqual({
      type: "assistantDelta", runId: "run-1", content: "ask works",
    });
  });

  it("reports the Superpowers resource path when Edit cannot initialize it", async () => {
    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");

    await expect(
      createConfiguredAgentRunner({} as never, { provider: "deepseek" }, { superpowersResourceRoot: "E:\\missing-superpowers" } as never, "edit"),
    ).rejects.toThrow("E:\\missing-superpowers");
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
      type: "agentEvent",
      runId: "run-1",
      message: "Running tool exploreCode (step 1, call 1): provider registry model context",
    });
    expect(hostMessages).toContainEqual({
      type: "agentEvent",
      runId: "run-1",
      message: "Tool exploreCode returned (step 1, call 1): 28 chars",
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

async function collectHostMessages(runner: AgentRunner, task: string): Promise<HostToWebviewMessage[]> {
  const messages: HostToWebviewMessage[] = [];
  for await (const message of runner.run({
    runId: "run-1",
    task,
    signal: new AbortController().signal,
  })) {
    messages.push(message);
  }
  return messages;
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
