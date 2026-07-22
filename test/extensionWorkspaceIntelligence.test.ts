import { describe, expect, it, vi } from "vitest";

import type { AgentRunner, AgentRunRequest } from "../src/extension/agentRunner";
import type { WebviewToHostMessage } from "../src/shared/messages";
import type { SuperpowersCheckpoint } from "../src/shared/chatTypes";

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
      CodeLens: class {},
      EventEmitter: class {
        readonly event = () => createDisposable();
        fire() {}
        dispose() {}
      },
      Position: class {},
      Range: class {},
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
      languages: {
        registerCodeLensProvider: vi.fn(() => createDisposable()),
      },
      workspace: {
        registerTextDocumentContentProvider: vi.fn(() => createDisposable()),
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

    const webviewView = createFakeWebviewView((listener) => {
      messageListener = listener;
    });
    registeredProvider?.resolveWebviewView(webviewView);
    messageListener?.({ type: "startTask", runId: "run-1", task: "first run" });
    messageListener?.({ type: "startTask", runId: "run-2", task: "second run" });

    expect(createTreeSitterParserRuntime).toHaveBeenCalledTimes(1);
    expect(createVsCodeWorkspaceIntelligence).toHaveBeenCalledTimes(1);
    expect(createVsCodeWorkspaceIntelligence.mock.calls[0]?.[1]).toEqual({ parserRuntime, storageUri });
    expect(createConfiguredAgentRunner).toHaveBeenCalledTimes(2);
    expect(createConfiguredAgentRunner.mock.calls[0]?.[2]?.workspaceIntelligence).toBe(workspaceIntelligence);
    expect(createConfiguredAgentRunner.mock.calls[1]?.[2]?.workspaceIntelligence).toBe(workspaceIntelligence);
    expect(createConfiguredAgentRunner.mock.calls[0]?.[2]?.readFileTool).toBe(
      createConfiguredAgentRunner.mock.calls[1]?.[2]?.readFileTool,
    );
    expect(createConfiguredAgentRunner.mock.calls[0]?.[2]?.applyEditTool).toBe(
      createConfiguredAgentRunner.mock.calls[1]?.[2]?.applyEditTool,
    );
    expect(webviewView.webview.postMessage).toHaveBeenCalledWith({
      type: "conversationStarted",
      conversationId: expect.any(String),
      runId: "run-1",
      userMessage: "first run",
    });

    await deactivate();
    expect(workspaceIntelligence.dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels the active run's signal when a stopRun message is received", async () => {
    const capturedRequests: AgentRunRequest[] = [];
    const createConfiguredAgentRunner = vi.fn(async (): Promise<AgentRunner> => ({
      run: async function* (request) {
        capturedRequests.push(request);
        await new Promise(() => {});
      },
    }));
    const workspaceIntelligence = {
      buildCodeIntelligencePrompt: vi.fn(async () => ""),
      getStatus: vi.fn(() => "ready"),
      getDiagnostics: vi.fn(() => []),
      dispose: vi.fn(async () => undefined),
    };
    let registeredProvider: { resolveWebviewView(webviewView: FakeWebviewView): void } | undefined;
    let messageListener: WebviewMessageListener | undefined;

    vi.resetModules();
    vi.doMock("vscode", () => ({
      CodeLens: class {},
      EventEmitter: class {
        readonly event = () => createDisposable();
        fire() {}
        dispose() {}
      },
      Position: class {},
      Range: class {},
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
      languages: {
        registerCodeLensProvider: vi.fn(() => createDisposable()),
      },
      workspace: {
        registerTextDocumentContentProvider: vi.fn(() => createDisposable()),
      },
    }));
    vi.doMock("../src/extension/model/providerRegistry", () => ({
      createConfiguredAgentRunner,
    }));
    vi.doMock("../src/extension/intelligence/parser/treeSitterRuntime", () => ({
      createTreeSitterParserRuntime: vi.fn(() => ({ parse: vi.fn() })),
    }));
    vi.doMock("../src/extension/intelligence/vscodeWorkspaceIntelligence", () => ({
      createVsCodeWorkspaceIntelligence: vi.fn(() => workspaceIntelligence),
    }));

    const { activate } = await import("../src/extension");
    activate({ subscriptions: [], extensionUri: { fsPath: "E:\\work\\extension" }, storageUri: { fsPath: "E:\\storage" } } as never);

    registeredProvider?.resolveWebviewView(createFakeWebviewView((listener) => {
      messageListener = listener;
    }));
    messageListener?.({ type: "startTask", runId: "run-1", task: "long running task" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capturedRequests[0]?.signal.aborted).toBe(false);

    messageListener?.({ type: "stopRun" });

    expect(capturedRequests[0]?.signal.aborted).toBe(true);
  });

  it("restores a cancelled Edit workflow from its conversation checkpoint after switching back", async () => {
    const capturedRequests: AgentRunRequest[] = [];
    const workflowCheckpoints = new Map<string, SuperpowersCheckpoint>();
    const workflowStore = {
      save: (checkpoint: SuperpowersCheckpoint) => workflowCheckpoints.set(checkpoint.conversationId, checkpoint),
      load: (conversationId: string) => workflowCheckpoints.get(conversationId),
      clear: (conversationId: string) => workflowCheckpoints.delete(conversationId),
    };
    const createConfiguredAgentRunner = vi.fn(async (): Promise<AgentRunner> => ({
      run: async function* (request) {
        capturedRequests.push(request);
        if (request.runId === "run-edit") await new Promise<void>(() => {});
      },
    }));
    let registeredProvider: { resolveWebviewView(webviewView: FakeWebviewView): void } | undefined;
    let messageListener: WebviewMessageListener | undefined;

    vi.resetModules();
    vi.doMock("vscode", () => createFakeVsCode((provider) => { registeredProvider = provider; }));
    vi.doMock("../src/extension/model/providerRegistry", () => ({ createConfiguredAgentRunner }));
    vi.doMock("../src/extension/intelligence/parser/treeSitterRuntime", () => ({ createTreeSitterParserRuntime: vi.fn(() => ({ parse: vi.fn() })) }));
    vi.doMock("../src/extension/intelligence/vscodeWorkspaceIntelligence", () => ({
      createVsCodeWorkspaceIntelligence: vi.fn(() => ({ dispose: vi.fn(async () => undefined) })),
    }));
    vi.doMock("../src/extension/superpowers/workflowStore", () => ({ createWorkflowStore: () => workflowStore }));

    const { activate } = await import("../src/extension");
    activate({ subscriptions: [], extensionUri: { fsPath: "E:\\work\\extension" }, storageUri: { fsPath: "E:\\storage" } } as never);
    const view = createFakeWebviewView((listener) => { messageListener = listener; });
    registeredProvider?.resolveWebviewView(view);

    messageListener?.({ type: "startTask", runId: "run-edit", task: "Edit the original conversation", mode: "edit" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const originalConversationId = (view.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .find(([message]) => (message as { type?: string }).type === "conversationStarted")?.[0]
      .conversationId as string;
    workflowStore.save({
      version: 1, conversationId: originalConversationId, runId: "run-edit", phase: "implement", skillNames: [], taskIndex: 0, updatedAt: 1,
    });

    messageListener?.({ type: "startTask", runId: "run-other", task: "Other conversation", mode: "ask" });
    expect(capturedRequests.find((request) => request.runId === "run-edit")?.signal.aborted).toBe(true);
    messageListener?.({ type: "switchConversation", conversationId: originalConversationId });

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "runInterrupted", runId: "run-edit", conversationId: originalConversationId, task: "Edit the original conversation",
    });

    messageListener?.({ type: "resumeRun", runId: "run-resume", conversationId: originalConversationId });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedRequests.at(-1)?.conversationId).toBe(originalConversationId);
    expect(capturedRequests.at(-1)?.resumeState).toEqual({
      kind: "superpowers", checkpoint: expect.objectContaining({ conversationId: originalConversationId, runId: "run-edit" }),
    });
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

function createFakeVsCode(registerProvider: (provider: { resolveWebviewView(webviewView: FakeWebviewView): void }) => void) {
  return {
    CodeLens: class {},
    EventEmitter: class { readonly event = () => createDisposable(); fire() {} dispose() {} },
    Position: class {},
    Range: class {},
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => createDisposable()) },
    window: {
      registerWebviewViewProvider: vi.fn((_viewId, provider) => { registerProvider(provider); return createDisposable(); }),
      showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showInputBox: vi.fn(),
    },
    Uri: { joinPath: vi.fn((_base, ...segments: string[]) => ({ toString: () => segments.join("/") })) },
    languages: { registerCodeLensProvider: vi.fn(() => createDisposable()) },
    workspace: { registerTextDocumentContentProvider: vi.fn(() => createDisposable()) },
  };
}
