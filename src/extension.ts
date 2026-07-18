import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

import * as vscode from "vscode";

import { createApplyEditTool } from "./extension/agent/applyEditTool";
import { createEditPreviewService } from "./extension/agent/editPreviewService";
import { createReadFileTool } from "./extension/agent/readFileTool";
import { startAgentRun, type AgentRunHandle } from "./extension/agentRunner";
import { createTreeSitterParserRuntime } from "./extension/intelligence/parser/treeSitterRuntime";
import { createVsCodeWorkspaceIntelligence } from "./extension/intelligence/vscodeWorkspaceIntelligence";
import { openProjectMemory, type ProjectMemory } from "./extension/memory/projectMemory";
import type { MemoryKind, ReadRange } from "./extension/memory/types";
import { clearModelApiKey, getConfiguredProviderId, setModelApiKey } from "./extension/model/modelConfig";
import { createConfiguredAgentRunner } from "./extension/model/providerRegistry";
import { createWebviewHtml } from "./extension/webviewHtml";
import type { WebviewToHostMessage } from "./shared/messages";

const chatViewId = "loopagent.chat";
const viewContainerId = "workbench.view.extension.loopagent";
const noWorkspaceMessage = "当前没有可用工作区";
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

  const projectMemory = openWorkspaceProjectMemory(context);
  const rememberProjectMemoryCommand = vscode.commands.registerCommand("loopagent.rememberProjectMemory", async () => {
    await runRememberProjectMemory(projectMemory);
  });
  const showProjectMemoryCommand = vscode.commands.registerCommand("loopagent.showProjectMemory", async () => {
    await runShowProjectMemory(projectMemory);
  });
  const forgetProjectMemoryCommand = vscode.commands.registerCommand("loopagent.forgetProjectMemory", async () => {
    await runForgetProjectMemory(projectMemory);
  });

  context.subscriptions.push(
    helloCommand,
    focusChatCommand,
    setModelApiKeyCommand,
    clearModelApiKeyCommand,
    chatViewRegistration,
    rememberProjectMemoryCommand,
    showProjectMemoryCommand,
    forgetProjectMemoryCommand,
    { dispose: () => projectMemory?.dispose() },
  );
}

/** Opens (or degrades gracefully from) the project memory store for the current workspace. */
function openWorkspaceProjectMemory(context: vscode.ExtensionContext): ProjectMemory | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (!context.storageUri || workspaceFolders.length === 0) return undefined;

  try {
    mkdirSync(context.storageUri.fsPath, { recursive: true });
    const databasePath = join(context.storageUri.fsPath, "memory.sqlite");
    const workspaceKey = computeWorkspaceKey(workspaceFolders);
    return openProjectMemory(databasePath, workspaceKey, readFileRange);
  } catch {
    // Open failure degrades to no-memory mode; commands report "no workspace available".
    return undefined;
  }
}

function computeWorkspaceKey(workspaceFolders: readonly vscode.WorkspaceFolder[]): string {
  const roots = workspaceFolders.map((folder) => normalize(folder.uri.fsPath).toLowerCase()).sort();
  return createHash("sha256").update(roots.join("|")).digest("hex");
}

const readFileRange: ReadRange = (filePath, startLine, endLine) => {
  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    return lines.slice(startLine, endLine + 1).join("\n");
  } catch {
    return "";
  }
};

async function runRememberProjectMemory(projectMemory: ProjectMemory | undefined): Promise<void> {
  if (!projectMemory) {
    vscode.window.showInformationMessage(noWorkspaceMessage);
    return;
  }

  const expectedGeneration = projectMemory.getGeneration();
  const picked = await vscode.window.showQuickPick<{ label: string; memoryKind: MemoryKind }>(
    [
      { label: "事实 (fact)", memoryKind: "fact" },
      { label: "决策 (decision)", memoryKind: "decision" },
    ],
    { placeHolder: "选择记忆类型" },
  );
  if (!picked) return;

  const subject = await vscode.window.showInputBox({ prompt: "主题", ignoreFocusOut: true });
  if (!subject) return;

  const content = await vscode.window.showInputBox({ prompt: "内容", ignoreFocusOut: true });
  if (!content) return;

  try {
    const result = projectMemory.remember({ expectedGeneration, kind: picked.memoryKind, subject, content });
    if (!result.ok) {
      vscode.window.showWarningMessage(`记忆未保存：${result.reason}`);
      return;
    }
    vscode.window.showInformationMessage("已记住。");
  } catch {
    vscode.window.showWarningMessage("记忆操作失败。");
  }
}

async function runShowProjectMemory(projectMemory: ProjectMemory | undefined): Promise<void> {
  if (!projectMemory) {
    vscode.window.showInformationMessage(noWorkspaceMessage);
    return;
  }

  const items = projectMemory.list();
  if (items.length === 0) {
    vscode.window.showInformationMessage("暂无项目记忆。");
    return;
  }

  await vscode.window.showQuickPick(
    items.map((item) => ({ label: item.subject, description: item.kind, detail: item.content })),
  );
}

async function runForgetProjectMemory(projectMemory: ProjectMemory | undefined): Promise<void> {
  if (!projectMemory) {
    vscode.window.showInformationMessage(noWorkspaceMessage);
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    "确定要清空全部项目记忆吗？此操作无法撤销。",
    { modal: true },
    "清空",
  );
  if (confirmed !== "清空") return;

  try {
    const result = projectMemory.forget(projectMemory.getGeneration());
    if (!result.ok) {
      vscode.window.showWarningMessage("未删除。");
      return;
    }
    vscode.window.showInformationMessage("项目记忆已清空。");
  } catch {
    vscode.window.showWarningMessage("记忆操作失败。");
  }
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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
      parserRuntime: createTreeSitterParserRuntime(),
      storageUri: context.storageUri,
    });
    this.editPreviewService = createEditPreviewService(vscode);
    this.readFileTool = createReadFileTool(vscode);
    this.applyEditTool = createApplyEditTool(this.editPreviewService);
  }

  async dispose(): Promise<void> {
    this.activeRun?.cancel();
    this.editPreviewService.dispose();
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
      readFileTool: this.readFileTool,
      applyEditTool: this.applyEditTool,
    }).then((runner) => {
      const run = startAgentRun({
        task: message.task,
        mode: message.mode ?? "edit",
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
