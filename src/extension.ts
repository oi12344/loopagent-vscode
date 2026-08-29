import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

import * as vscode from "vscode";

import { createApplyEditTool } from "./extension/agent/applyEditTool";
import { createEditPreviewService } from "./extension/agent/editPreviewService";
import { createReadFileTool } from "./extension/agent/readFileTool";
import { createListDirectoryTool } from "./extension/agent/listDirectoryTool";
import { createRunCommandTool } from "./extension/agent/runCommandTool";
import { createCommandApprovalBroker, type CommandApprovalBroker } from "./extension/agent/commandApprovalBroker";
import { startAgentRun, type AgentRunHandle } from "./extension/agentRunner";
import { createTreeSitterParserRuntime } from "./extension/intelligence/parser/treeSitterRuntime";
import { createVsCodeWorkspaceIntelligence } from "./extension/intelligence/vscodeWorkspaceIntelligence";
import { openProjectMemory, type ProjectMemory } from "./extension/memory/projectMemory";
import type { MemoryKind, ReadRange } from "./extension/memory/types";
import { clearModelApiKey, getConfiguredProviderId, setModelApiKey } from "./extension/model/modelConfig";
import { createConfiguredAgentRunner } from "./extension/model/providerRegistry";
import { createWebviewHtml } from "./extension/webviewHtml";
import { createConversationStore } from "./extension/conversation/conversationStore";
import type { ConversationStore } from "./extension/conversation/conversationStore";
import { createPersistentConversationStore } from "./extension/conversation/persistentConversationStore";
import { createConversationManager, type ConversationManager } from "./extension/conversation/conversationManager";
import type { WebviewToHostMessage, HostToWebviewMessage, RunMode, RunModelSelection, CommandPermission, ImageAttachment } from "./shared/messages";
import type { ChatMessage, InterruptedRunCheckpoint } from "./shared/chatTypes";
import { DeepSeekVisionService } from "./extension/vision/deepseekVisionService";
import { ImageAnalysisService } from "./extension/vision/imageAnalysisService";

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

  const undoLastEditCommand = vscode.commands.registerCommand("loopagent.undoLastEdit", async () => {
    const result = await chatProvider.undoLastEdit();
    vscode.window.showInformationMessage(result);
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
    undoLastEditCommand,
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

function createConversationStoreForWorkspace(workspaceRoot: string): ConversationStore & { close?(): void } {
  try {
    return createPersistentConversationStore(join(workspaceRoot, ".loopagent", "conversation.sqlite"));
  } catch {
    return createConversationStore();
  }
}

class LoopAgentChatViewProvider implements vscode.WebviewViewProvider {
  private activeRun: AgentRunHandle | undefined;
  private readonly workspaceIntelligence;
  private readonly editPreviewService;
  private readonly readFileTool;
  private readonly listDirectoryTool;
  private readonly applyEditTool;
  private readonly commandApprovalBroker: CommandApprovalBroker;
  private readonly commandOutputChannel: vscode.OutputChannel;
  private activeWebviewView: vscode.WebviewView | undefined;
  private readonly conversationStore: ConversationStore & { close?(): void };
  private readonly conversationManager: ConversationManager;
  private currentConversationId: string | undefined;
  private readonly visionService: DeepSeekVisionService;
  private readonly imageAnalysisService: ImageAnalysisService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
      parserRuntime: createTreeSitterParserRuntime(),
      storageUri: context.storageUri,
    });
    this.commandApprovalBroker = createCommandApprovalBroker({
      isWebviewVisible: () => this.activeWebviewView?.visible ?? false,
      postMessage: (message) => {
        this.activeWebviewView?.webview.postMessage(message);
      },
      fallbackApprove: async ({ command, cwd }) => {
        const approved = await vscode.window.showWarningMessage(
          "LoopAgent wants to run a command.",
          { modal: true, detail: `Command:\n${command}\n\nWorking directory:\n${cwd}` },
          "Run",
        );
        return approved === "Run";
      },
    });
    this.editPreviewService = createEditPreviewService(vscode, {
      notify: (notice) => {
        this.activeWebviewView?.webview.postMessage({
          type: "editApplied",
          notificationId: notice.notificationId,
          files: notice.files,
          fileStats: notice.fileStats,
        } satisfies HostToWebviewMessage);
      },
    });
    this.readFileTool = createReadFileTool(vscode);
    this.listDirectoryTool = createListDirectoryTool(vscode);
    this.applyEditTool = createApplyEditTool(this.editPreviewService);

    // 创建命令执行输出通道（用于自动恢复日志）
    this.commandOutputChannel = vscode.window.createOutputChannel('LoopAgent - Command Execution');

    // 初始化视觉服务
    const modelConfig = vscode.workspace.getConfiguration("loopagent.model");
    this.visionService = new DeepSeekVisionService({
      apiKey: async () => {
        const provider = getConfiguredProviderId();
        const secretKey = `loopagent.model.apiKey.${provider}`;
        return context.secrets.get(secretKey);
      },
      baseUrl: modelConfig.get<string>("baseUrl", "").trim() || undefined,
    });
    this.imageAnalysisService = new ImageAnalysisService(this.visionService);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.conversationStore = workspaceRoot
      ? createConversationStoreForWorkspace(workspaceRoot)
      : createConversationStore();
    this.conversationManager = createConversationManager(this.conversationStore);
  }

  async dispose(): Promise<void> {
    this.activeRun?.cancel();
    this.editPreviewService.dispose();
    await this.workspaceIntelligence.dispose();
    await this.visionService.dispose();
    this.conversationStore.close?.();
  }

  undoLastEdit(): Promise<string> {
    return this.editPreviewService.undoLast();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.activeWebviewView = webviewView;
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
      } else if (message.type === "switchConversation") {
        this.handleSwitchConversation(message, webviewView.webview);
      } else if (message.type === "stopRun") {
        this.handleStopRun(webviewView.webview);
      } else if (message.type === "resumeRun") {
        this.handleResumeRun(message, webviewView.webview);
      } else if (message.type === "webviewReady") {
        this.handleWebviewReady(webviewView.webview);
      } else if (message.type === "commandApprovalResolved") {
        this.commandApprovalBroker.resolve(message.approvalId, message.approved);
      } else if (message.type === "editRevertRequested") {
        void this.editPreviewService.revertFiles(message.notificationId, message.paths).then((result) => {
          webviewView.webview.postMessage({
            type: "editRevertResult",
            notificationId: message.notificationId,
            paths: message.paths,
            succeeded: result === "Changes were undone.",
            message: result,
          } satisfies HostToWebviewMessage);
        });
      } else if (message.type === "editFileOpened") {
        void this.editPreviewService.openFilePreview(message.notificationId, message.path);
      }
    });

    webviewView.onDidDispose(() => {
      this.activeRun?.cancel();
      messageSubscription.dispose();
      if (this.activeWebviewView === webviewView) {
        this.activeWebviewView = undefined;
      }
    });
  }

  private handleWebviewReady(webview: vscode.Webview): void {
    const restored = this.conversationManager.loadActiveConversation();
    if (restored) {
      this.currentConversationId = restored.conversationId;
      webview.postMessage({
        type: "conversationRestored",
        conversationId: restored.conversationId,
        messages: restored.messages,
      } satisfies HostToWebviewMessage);
      this.sendInterruptedRun(webview, restored.conversationId);
    }

    this.sendConversationList(webview);
  }

  private handleNewConversation(): void {
    this.activeRun?.cancel();
    if (this.currentConversationId) {
      this.conversationManager.clearInterruptedRun(this.currentConversationId);
    }
    this.currentConversationId = undefined;
    this.conversationManager.clearActiveConversation();
  }

  private handleSwitchConversation(
    message: Extract<WebviewToHostMessage, { type: "switchConversation" }>,
    webview: vscode.Webview,
  ): void {
    const conversation = this.conversationManager.setActiveConversation(message.conversationId);
    if (!conversation) {
      return;
    }

    this.activeRun?.cancel();
    this.currentConversationId = conversation.conversationId;
    webview.postMessage({
      type: "conversationRestored",
      conversationId: conversation.conversationId,
      messages: conversation.messages,
    } satisfies HostToWebviewMessage);
    this.sendInterruptedRun(webview, conversation.conversationId);
  }

  private sendInterruptedRun(webview: vscode.Webview, conversationId: string): void {
    const checkpoint = this.conversationManager.loadInterruptedRun(conversationId);
    if (!checkpoint) return;
    webview.postMessage({
      type: "runInterrupted",
      runId: checkpoint.runId,
      conversationId: checkpoint.conversationId,
      task: checkpoint.task,
    } satisfies HostToWebviewMessage);
  }

  private handleStopRun(webview: vscode.Webview): void {
    const run = this.activeRun;
    const conversationId = this.currentConversationId;
    if (!run || !conversationId) return;

    run.cancel();
    void run.done.finally(() => {
      const checkpoint = this.conversationManager.loadInterruptedRun(conversationId);
      if (!checkpoint?.runId || checkpoint.runId !== run.runId) return;
      webview.postMessage({
        type: "runInterrupted",
        runId: checkpoint.runId,
        conversationId: checkpoint.conversationId,
        task: checkpoint.task,
      } satisfies HostToWebviewMessage);
    });
  }

  private handleResumeRun(
    message: Extract<WebviewToHostMessage, { type: "resumeRun" }>,
    webview: vscode.Webview,
  ): void {
    const checkpoint = this.conversationManager.loadInterruptedRun(message.conversationId);
    if (!checkpoint) {
      webview.postMessage({
        type: "runFailed",
        runId: message.runId,
        message: "Interrupted run is no longer available",
      } satisfies HostToWebviewMessage);
      return;
    }

    const conversation = this.conversationManager.getConversation(message.conversationId);
    if (!conversation) return;
    this.currentConversationId = conversation.conversationId;
    this.executeRun(
      message.runId,
      checkpoint.task,
      checkpoint.model,
      checkpoint.mode,
      checkpoint.commandPermission,
      this.conversationManager.getConversationHistory(conversation.conversationId),
      conversation.conversationId,
      webview,
      checkpoint,
    );
  }

  private sendConversationList(webview: vscode.Webview): void {
    webview.postMessage({
      type: "conversationList",
      conversations: this.conversationManager.listConversations(),
    } satisfies HostToWebviewMessage);
  }

  private handleStartTask(
    message: Extract<WebviewToHostMessage, { type: "startTask" }>,
    webview: vscode.Webview,
  ): void {
    const conversation = this.conversationManager.startConversation();
    this.currentConversationId = conversation.conversationId;
    this.conversationManager.addUserMessage(conversation.conversationId, message.task);
    const conversationHistory = this.conversationManager.getConversationHistory(conversation.conversationId);

    // 告诉 WebView 对话已开始，以便后续提问能使用 continueConversation
    webview.postMessage({
      type: "conversationStarted",
      conversationId: conversation.conversationId,
      runId: message.runId,
      userMessage: message.task,
    } satisfies HostToWebviewMessage);

    this.sendConversationList(webview);

    this.executeRun(
      message.runId,
      message.task,
      message.model,
      message.mode,
      message.commandPermission,
      conversationHistory,
      conversation.conversationId,
      webview,
      undefined,
      message.attachments,
    );
  }

  private handleContinueConversation(
    message: Extract<WebviewToHostMessage, { type: "continueConversation" }>,
    webview: vscode.Webview,
  ): void {
    this.currentConversationId = message.conversationId;
    this.conversationManager.clearInterruptedRun(message.conversationId);
    this.conversationManager.addUserMessage(message.conversationId, message.userMessage);
    const conversationHistory = this.conversationManager.getConversationHistory(message.conversationId);
    console.log(`[handleContinueConversation] conversationId=${message.conversationId}, history.length=${conversationHistory.length}`);
    if (conversationHistory.length > 0) {
      console.log(`[handleContinueConversation] Messages:`, conversationHistory.map(m => ({ role: m.role, contentLength: m.content.length })));
    }
    this.sendConversationList(webview);

    this.executeRun(
      message.runId,
      message.userMessage,
      message.model,
      message.mode,
      message.commandPermission,
      conversationHistory,
      message.conversationId,
      webview,
      undefined,
      message.attachments,
    );
  }

  private executeRun(
    runId: string,
    task: string,
    model: RunModelSelection | undefined,
    mode: RunMode | undefined,
    commandPermission: CommandPermission | undefined,
    conversationHistory: ChatMessage[],
    conversationId: string,
    webview: vscode.Webview,
    resumeCheckpoint?: InterruptedRunCheckpoint,
    attachments?: ImageAttachment[],
  ): void {
    this.activeRun?.cancel();

    const runCommandTool = createRunCommandTool(vscode, {
      approve: commandPermission === "full" ? async () => true : this.commandApprovalBroker.approve,
      enableAutoRecovery: true,
      outputChannel: this.commandOutputChannel,
    });

    const assistantMessages = new Map<string, { content: string; reasoning: string }>();

    const run = startAgentRun({
      runId,
      task,
      attachments,
      runner: createConfiguredAgentRunner(this.context, model, {
        workspaceIntelligence: this.workspaceIntelligence,
        readFileTool: this.readFileTool,
        listDirectoryTool: this.listDirectoryTool,
        applyEditTool: this.applyEditTool,
        runCommandTool,
        visionService: this.visionService,
        mode,
        onCheckpoint: (checkpoint) => {
          this.conversationManager.saveInterruptedRun({
            ...checkpoint,
            conversationId,
            model,
            mode,
            commandPermission,
          });
        },
      }),
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
            this.conversationManager.clearInterruptedRun(conversationId);
          }
        } else if (hostMessage.type === "runFinished") {
          this.conversationManager.clearInterruptedRun(conversationId);
        }

        webview.postMessage(hostMessage);
      },
      conversationHistory,
      conversationId,
      resumeState: resumeCheckpoint
        ? { kind: "react", checkpoint: resumeCheckpoint }
        : undefined,
    });

    this.activeRun = run;
    void run.done.finally(() => {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    });
  }

}

async function promptForModelApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = getConfiguredProviderId();

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
