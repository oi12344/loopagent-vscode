import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { VsCodeWorkspaceApi } from "../src/extension/intelligence/vscodeWorkspaceIntelligence";
import type { ModelMessage, ModelProvider } from "../src/extension/model/types";
import type { HostToWebviewMessage } from "../src/shared/messages";

describe("createConfiguredAgentRunner code intelligence context", () => {
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

  it("returns readFile and confirmed applyEdit observations to the model", async () => {
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
          } else {
            yield { type: "contentDelta", content: "Edit applied." };
          }
          yield { type: "finishReason", reason: capturedMessages.length < 3 ? "tool_calls" : "stop" };
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner = await createConfiguredAgentRunner(
      {} as never,
      { provider: "deepseek" },
      { workspaceIntelligence, readFileTool, applyEditTool },
    );

    await expect(collectHostMessages(runner, "Rename the constant.")).resolves.toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "Edit applied.",
    });

    const systemPrompt = capturedMessages[0]!
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    expect(systemPrompt).toContain("Before editing, read the relevant file content with readFile.");
    expect(systemPrompt).toContain("Propose all workspace changes only through applyEdit.");
    expect(systemPrompt).toContain("Do not claim an edit succeeded until applyEdit reports that it was applied.");
    expect(readFileTool.invoke).toHaveBeenCalledTimes(1);
    expect(applyEditTool.invoke).toHaveBeenCalledTimes(1);
    expect(capturedMessages[2]!.slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ id: "apply-call" })] }),
      expect.objectContaining({ role: "tool", toolCallId: "apply-call", name: "applyEdit", content: "Changes were applied." }),
    ]);
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
