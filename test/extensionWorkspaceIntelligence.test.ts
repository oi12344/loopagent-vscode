import { describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../src/extension/agentRunner";
import type { WebviewToHostMessage } from "../src/shared/messages";

type WebviewMessageListener = (message: WebviewToHostMessage) => void;

describe("LoopAgent extension workspace intelligence lifecycle", () => {
  it("reuses one workspace intelligence instance across chat runs", async () => {
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => ""),
      getStatus: vi.fn(() => "ready"),
      getDiagnostics: vi.fn(() => []),
      dispose: vi.fn(async () => undefined),
    };
    const parserRuntime = {
      parse: vi.fn(),
    };
    const createConfiguredAgentRunner = vi.fn(async (): Promise<AgentRunner> => createNoopRunner());
    const createVsCodeWorkspaceIntelligence = vi.fn(() => workspaceIntelligence);
    const createTreeSitterParserRuntime = vi.fn(() => parserRuntime);
    let registeredProvider: { resolveWebviewView(webviewView: FakeWebviewView): void } | undefined;
    let messageListener: WebviewMessageListener | undefined;

    vi.resetModules();
    vi.doMock("vscode", () => ({
      commands: {
        executeCommand: vi.fn(),
        registerCommand: vi.fn(() => createDisposable()),
      },
      window: {
        registerWebviewViewProvider: vi.fn((_viewId, provider) => {
          registeredProvider = provider;
          return createDisposable();
        }),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showInputBox: vi.fn(),
      },
      Uri: {
        joinPath: vi.fn((_base, ...segments: string[]) => ({
          toString: () => segments.join("/"),
        })),
      },
    }));
    vi.doMock("../src/extension/model/providerRegistry", () => ({
      createConfiguredAgentRunner,
    }));
    vi.doMock("../src/extension/intelligence/parser/treeSitterRuntime", () => ({
      createTreeSitterParserRuntime,
    }));
    vi.doMock("../src/extension/intelligence/vscodeWorkspaceIntelligence", () => ({
      createVsCodeWorkspaceIntelligence,
    }));

    const { activate, deactivate } = await import("../src/extension");
    const storageUri = { fsPath: "E:\\storage" };
    activate({ subscriptions: [], extensionUri: { fsPath: "E:\\work\\extension" }, storageUri } as never);

    registeredProvider?.resolveWebviewView(createFakeWebviewView((listener) => {
      messageListener = listener;
    }));
    messageListener?.({ type: "startTask", task: "first run" });
    messageListener?.({ type: "startTask", task: "second run" });

    expect(createTreeSitterParserRuntime).toHaveBeenCalledTimes(1);
    expect(createVsCodeWorkspaceIntelligence).toHaveBeenCalledTimes(1);
    expect(createVsCodeWorkspaceIntelligence.mock.calls[0]?.[1]).toEqual({ parserRuntime, storageUri });
    expect(createConfiguredAgentRunner).toHaveBeenCalledTimes(2);
    expect(createConfiguredAgentRunner.mock.calls[0]?.[2]?.workspaceIntelligence).toBe(workspaceIntelligence);
    expect(createConfiguredAgentRunner.mock.calls[1]?.[2]?.workspaceIntelligence).toBe(workspaceIntelligence);

    await deactivate();
    expect(workspaceIntelligence.dispose).toHaveBeenCalledTimes(1);
  });
});

type FakeWebviewView = {
  webview: {
    options: Record<string, unknown>;
    cspSource: string;
    html: string;
    asWebviewUri(uri: { toString(): string }): { toString(): string };
    onDidReceiveMessage(listener: WebviewMessageListener): { dispose(): void };
    postMessage: (message: unknown) => boolean;
  };
  onDidDispose(listener: () => void): { dispose(): void };
};

function createFakeWebviewView(registerMessageListener: (listener: WebviewMessageListener) => void): FakeWebviewView {
  return {
    webview: {
      options: {},
      cspSource: "vscode-webview:",
      html: "",
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: (listener) => {
        registerMessageListener(listener);
        return createDisposable();
      },
      postMessage: vi.fn(() => true),
    },
    onDidDispose: vi.fn(() => createDisposable()),
  };
}

function createNoopRunner(): AgentRunner {
  return {
    run: async function* () {
      return;
    },
  };
}

function createDisposable(): { dispose(): void } {
  return { dispose: vi.fn() };
}
