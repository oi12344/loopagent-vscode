import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { VsCodeWorkspaceApi } from "../src/extension/intelligence/vscodeWorkspaceIntelligence";
import type { ModelMessage, ModelProvider } from "../src/extension/model/types";
import type { HostToWebviewMessage } from "../src/shared/messages";

describe("createConfiguredAgentRunner code intelligence context", () => {
  it("sends VS Code workspace search results to the model system prompt", async () => {
    const workspaceRoot = "E:\\work\\repo";
    const workspaceFiles = new Map<string, string>([
      [
        `${workspaceRoot}\\src\\modelAccess.ts`,
        [
          "export function createDeepSeekProvider() {",
          "  return { provider: \"deepseek\" };",
          "}",
          "",
        ].join("\n"),
      ],
      [`${workspaceRoot}\\.env`, "DEEPSEEK_API_KEY=should-not-be-indexed"],
    ]);
    const capturedMessages: ModelMessage[][] = [];

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
        },
      }),
    }));

    const { createConfiguredAgentRunner } = await import("../src/extension/model/providerRegistry");
    const runner: AgentRunner = await createConfiguredAgentRunner({} as never, { provider: "deepseek" }, {
      vscodeApi: createFakeVsCodeWorkspaceApi(workspaceRoot, workspaceFiles),
    });

    await collectHostMessages(runner, "模型接入 createDeepSeekProvider");

    const systemPrompt = capturedMessages[0]!
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    expect(systemPrompt).toContain("runtime context");
    expect(systemPrompt).toContain("代码语义索引上下文");
    expect(systemPrompt).toContain("createDeepSeekProvider");
    expect(systemPrompt).toContain("src/modelAccess.ts");
    expect(systemPrompt).not.toContain("DEEPSEEK_API_KEY");
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
