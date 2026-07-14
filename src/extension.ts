import * as vscode from "vscode";

import { startAgentRun, type AgentRunHandle } from "./extension/agentRunner";
import { createTreeSitterParserRuntime } from "./extension/intelligence/parser/treeSitterRuntime";
import { createVsCodeWorkspaceIntelligence } from "./extension/intelligence/vscodeWorkspaceIntelligence";
import { clearModelApiKey, getConfiguredProviderId, setModelApiKey } from "./extension/model/modelConfig";
import { createConfiguredAgentRunner } from "./extension/model/providerRegistry";
import { createWebviewHtml } from "./extension/webviewHtml";
import type { WebviewToHostMessage } from "./shared/messages";

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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
      parserRuntime: createTreeSitterParserRuntime(),
      storageUri: context.storageUri,
    });
  }

  async dispose(): Promise<void> {
    this.activeRun?.cancel();
    await this.workspaceIntelligence.dispose();
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
        this.startRun(message, webviewView.webview);
      }
    });

    webviewView.onDidDispose(() => {
      this.activeRun?.cancel();
      messageSubscription.dispose();
    });
  }

  private startRun(message: Extract<WebviewToHostMessage, { type: "startTask" }>, webview: vscode.Webview): void {
    this.activeRun?.cancel();

    void createConfiguredAgentRunner(this.context, message.model, {
      workspaceIntelligence: this.workspaceIntelligence,
    }).then((runner) => {
      const run = startAgentRun({
        task: message.task,
        runner,
        postMessage: (hostMessage) => webview.postMessage(hostMessage),
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
