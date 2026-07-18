import * as vscode from "vscode";
import { join } from "node:path";

import { createApplyEditTool } from "./extension/agent/applyEditTool";
import { createEditPreviewService } from "./extension/agent/editPreviewService";
import { createReadFileTool } from "./extension/agent/readFileTool";
import { startAgentRun, type AgentRunHandle } from "./extension/agentRunner";
import { createTreeSitterParserRuntime } from "./extension/intelligence/parser/treeSitterRuntime";
import { createVsCodeWorkspaceIntelligence } from "./extension/intelligence/vscodeWorkspaceIntelligence";
import { clearModelApiKey, getConfiguredProviderId, setModelApiKey } from "./extension/model/modelConfig";
import { createConfiguredAgentRunner } from "./extension/model/providerRegistry";
import { createWebviewHtml } from "./extension/webviewHtml";
import { createConversationStore } from "./extension/conversation/conversationStore";
import type { ConversationStore } from "./extension/conversation/conversationStore";
import { createPersistentConversationStore } from "./extension/conversation/persistentConversationStore";
import { createConversationManager, type ConversationManager } from "./extension/conversation/conversationManager";
import type { WebviewToHostMessage, HostToWebviewMessage, TaskMode, RunModelSelection } from "./shared/messages";
import type { ChatMessage } from "./shared/chatTypes";

const chatViewId = "loopagent.chat";
const viewContainerId = "workbench.view.extension.loopagent";
let activeChatProvider: LoopAgentChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const chatProvider = new LoopAgentChatViewProvider(context);
  activeChatProvider = chatProvider;

  const helloCommand = vscode.commands.registerCommand("loopagent.hello", () => {
    vscode.window.showInformationMessage("Hello from LoopAgent");
  });

  const focusChatCommand = vscode.commands.registerCommand("loopagent.focusChat", async () => {
    await vscode.commands.executeCommand(viewContainerId);
    await vscode.commands.executeCommand(`${chatViewId}.focus`);
  });

  const setModelApiKeyCommand = vscode.commands.registerCommand("loopagent.setModelApiKey", async () => {
    await promptForModelApiKey(context);
  });

  const clearModelApiKeyCommand = vscode.commands.registerCommand("loopagent.clearModelApiKey", async () => {
    await clearConfiguredModelApiKey(context);
  });

  const chatViewRegistration = vscode.window.registerWebviewViewProvider(chatViewId, chatProvider, {
    webviewOptions: {
      retainContextWhenHidden: true,
    },
  });

  context.subscriptions.push(
    helloCommand,
    focusChatCommand,
    setModelApiKeyCommand,
    clearModelApiKeyCommand,
    chatViewRegistration,
  );
}

export async function deactivate(): Promise<void> {
  const provider = activeChatProvider;
  activeChatProvider = undefined;
  await provider?.dispose();
}

class LoopAgentChatViewProvider implements vscode.WebviewViewProvider {
  private activeRun: AgentRunHandle | undefined;
  private readonly workspaceIntelligence;
  private readonly editPreviewService;
  private readonly readFileTool;
  private readonly applyEditTool;
  private readonly conversationStore: ConversationStore & { close?(): void };
  private readonly conversationManager: ConversationManager;
  private currentConversationId: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
      parserRuntime: createTreeSitterParserRuntime(),
      storageUri: context.storageUri,
    });
    this.editPreviewService = createEditPreviewService(vscode);
    this.readFileTool = createReadFileTool(vscode);
    this.applyEditTool = createApplyEditTool(this.editPreviewService);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.conversationStore = workspaceRoot
      ? createPersistentConversationStore(join(workspaceRoot, ".loopagent", "conversation.sqlite"))
      : createConversationStore();
    this.conversationManager = createConversationManager(this.conversationStore);
  }

  async dispose(): Promise<void> {
    this.activeRun?.cancel();
    this.editPreviewService.dispose();
    await this.workspaceIntelligence.dispose();
    this.conversationStore.close?.();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };

    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    const nonce = createNonce();

    webviewView.webview.html = createWebviewHtml({
      cspSource: webviewView.webview.cspSource,
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });

    const messageSubscription = webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === "startTask") {
        this.handleStartTask(message, webviewView.webview);
      } else if (message.type === "continueConversation") {
        this.handleContinueConversation(message, webviewView.webview);
      } else if (message.type === "newConversation") {
        this.handleNewConversation();
      } else if (message.type === "webviewReady") {
        this.handleWebviewReady(webviewView.webview);
      }
    });

    webviewView.onDidDispose(() => {
      this.activeRun?.cancel();
      messageSubscription.dispose();
    });
  }

  private handleWebviewReady(webview: vscode.Webview): void {
    const restored = this.conversationManager.loadActiveConversation();
    if (!restored) {
      return;
    }

    this.currentConversationId = restored.conversationId;
    webview.postMessage({
      type: "conversationRestored",
      conversationId: restored.conversationId,
      messages: restored.messages,
    } satisfies HostToWebviewMessage);
  }

  private handleNewConversation(): void {
    this.activeRun?.cancel();
    this.currentConversationId = undefined;
    this.conversationManager.clearActiveConversation();
  }

  private handleStartTask(
    message: Extract<WebviewToHostMessage, { type: "startTask" }>,
    webview: vscode.Webview,
  ): void {
    const conversation = this.conversationManager.startConversation();
    this.currentConversationId = conversation.conversationId;
    this.conversationManager.addUserMessage(conversation.conversationId, message.task);
    const conversationHistory = this.conversationManager.getConversationHistory(conversation.conversationId);

    this.executeRun(message.task, message.mode, message.model, conversationHistory, conversation.conversationId, webview);
  }

  private handleContinueConversation(
    message: Extract<WebviewToHostMessage, { type: "continueConversation" }>,
    webview: vscode.Webview,
  ): void {
    this.currentConversationId = message.conversationId;
    this.conversationManager.addUserMessage(message.conversationId, message.userMessage);
    const conversationHistory = this.conversationManager.getConversationHistory(message.conversationId);

    this.executeRun(message.userMessage, message.mode, message.model, conversationHistory, message.conversationId, webview);
  }

  private executeRun(
    task: string,
    mode: TaskMode | undefined,
    model: RunModelSelection | undefined,
    conversationHistory: ChatMessage[],
    conversationId: string,
    webview: vscode.Webview,
  ): void {
    this.activeRun?.cancel();

    const assistantMessages = new Map<string, { content: string; reasoning: string }>();

    void createConfiguredAgentRunner(this.context, model, {
      workspaceIntelligence: this.workspaceIntelligence,
      readFileTool: this.readFileTool,
      applyEditTool: this.applyEditTool,
    }).then((runner) => {
      const run = startAgentRun({
        task,
        mode: mode ?? "edit",
        runner,
        postMessage: (hostMessage: HostToWebviewMessage) => {
          // Capture assistant content and reasoning
          if (hostMessage.type === "assistantDelta") {
            const current = assistantMessages.get(hostMessage.runId) ?? { content: "", reasoning: "" };
            current.content += hostMessage.content;
            assistantMessages.set(hostMessage.runId, current);
          } else if (hostMessage.type === "assistantReasoningDelta") {
            const current = assistantMessages.get(hostMessage.runId) ?? { content: "", reasoning: "" };
            current.reasoning += hostMessage.content;
            assistantMessages.set(hostMessage.runId, current);
          } else if (hostMessage.type === "assistantFinished") {
            const message = assistantMessages.get(hostMessage.runId);
            if (message && conversationId) {
              this.conversationManager.addAssistantMessage(conversationId, message.content, message.reasoning);
            }
          }

          webview.postMessage(hostMessage);
        },
        conversationHistory,
        conversationId,
      });

      this.activeRun = run;
      void run.done.finally(() => {
        if (this.activeRun === run) {
          this.activeRun = undefined;
        }
      });
    });
  }
}

async function promptForModelApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = getConfiguredProviderId();

  if (provider === "fake") {
    vscode.window.showWarningMessage("Select a real model provider before setting an API key.");
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    password: true,
    prompt: `Enter API key for ${provider}`,
    placeHolder: "API key",
  });

  if (apiKey === undefined) {
    return;
  }

  if (!apiKey.trim()) {
    vscode.window.showWarningMessage("API key was empty and was not saved.");
    return;
  }

  await setModelApiKey(context, provider, apiKey.trim());
  vscode.window.showInformationMessage(`API key saved for ${provider}.`);
}

async function clearConfiguredModelApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = getConfiguredProviderId();
  await clearModelApiKey(context, provider);
  vscode.window.showInformationMessage(`API key cleared for ${provider}.`);
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
