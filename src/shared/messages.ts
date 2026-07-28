import type { ChatMessage, ConversationSummary } from "./chatTypes";

/** 单个文件的增删行统计 */
export type EditFileStat = {
  path: string;
  added: number;
  removed: number;
};

/** 消息附件（图片、文件等） */
export type MessageAttachment = {
  /** 附件类型 */
  type: "image" | "file";
  /** 本地文件系统路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** MIME 类型（可选） */
  mimeType?: string;
};

/** AI 模型提供商标识 */
export type ModelProviderId = "deepseek";

/** 模型思维模式 */
export type ModelThinkingMode = "disabled" | "enabled";

/** 模型运行配置 */
export type RunModelSelection = {
  provider: ModelProviderId;
  model: string;
  thinking: ModelThinkingMode;
};

/**
 * WebView 发送给主程序的消息
 */
export type WebviewToHostMessage =
  | {
      type: "startTask";
      runId: string;
      task: string;
      model?: RunModelSelection;
      attachments?: MessageAttachment[];
    }
  | {
      type: "continueConversation";
      runId: string;
      conversationId: string;
      userMessage: string;
      model?: RunModelSelection;
      attachments?: MessageAttachment[];
    }
  | {
      /** Webview 挂载完成，可以安全接收恢复消息了 */
      type: "webviewReady";
    }
  | {
      /** 用户点击"新对话"，清空当前活跃对话 */
      type: "newConversation";
    }
  | {
      /** 用户从历史列表点击某个对话，切换过去 */
      type: "switchConversation";
      conversationId: string;
    }
  | {
      /** 用户点击"停止"，取消正在运行的对话轮次 */
      type: "stopRun";
    }
  | {
      type: "resumeRun";
      runId: string;
      conversationId: string;
    }
  | {
      /** 用户在审批卡片上做出的选择，approvalId 对应 commandApprovalRequested 携带的 id */
      type: "commandApprovalResolved";
      approvalId: string;
      approved: boolean;
    }
  | {
      /** 用户在改动已应用的卡片上请求撤销部分或全部文件；paths 为要撤销的文件路径集合 */
      type: "editRevertRequested";
      notificationId: string;
      paths: string[];
    }
  | {
      /** 用户点击了改动列表里的某个文件，请求 host 打开该文件的 diff 预览 */
      type: "editFileOpened";
      notificationId: string;
      path: string;
    };

export type HostToWebviewMessage =
  | {
      /** Run lifecycle: indicates a run has started */
      type: "runStarted";
      runId: string;
      task: string;
    }
  | {
      /** Agent activity: logs agent execution events and progress */
      type: "agentEvent";
      runId: string;
      message: string;
    }
  | {
      /** 工具调用开始：携带工具名和人类可读的输入摘要，用于并发工具调用的时间线展示 */
      type: "toolCallStarted";
      runId: string;
      callId: string;
      toolName: string;
      input: string;
    }
  | {
      /** 工具调用结束：按 callId 匹配上面的 toolCallStarted，携带截断后的输出 */
      type: "toolCallFinished";
      runId: string;
      callId: string;
      succeeded: boolean;
      output: string;
    }
  | {
      /** 请求用户审批一次命令执行；面板不可见时由 host 侧回退到原生弹窗，不会发出此消息 */
      type: "commandApprovalRequested";
      approvalId: string;
      command: string;
      cwd: string;
    }
  | {
      /** 一次代码改动已直接写入工作区（可能涉及多个文件）；用户可在此卡片上撤销部分或全部文件 */
      type: "editApplied";
      notificationId: string;
      files: string[];
      /** 每个文件的增删行统计，与 files 一一对应 */
      fileStats: EditFileStat[];
    }
  | {
      type: "workflowStateChanged";
      runId: string;
      phase: string;
    }
  | {
      type: "subagentPlanCreated";
      runId: string;
      agentId: string;
      task: string;
      role: "explorer" | "reviewer" | "planner" | "executor";
      dependsOn: string[];
    }
  | {
      type: "subagentStateChanged";
      runId: string;
      agentId: string;
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
    }
  | {
      /** Assistant initialization: signals assistant model is starting */
      type: "assistantStarted";
      runId: string;
      provider: string;
    }
  | {
      /** Assistant reasoning: initial thinking/planning step before generation */
      type: "assistantThinking";
      runId: string;
      message: string;
    }
  | {
      /** AI reasoning process (thinking chain content) - streaming intermediate thoughts and reasoning steps */
      type: "assistantReasoningDelta";
      runId: string;
      content: string;
    }
  | {
      /** AI output content (final generated output) - streaming the main response to the user */
      type: "assistantDelta";
      runId: string;
      content: string;
    }
  | {
      /** Assistant completion: signals assistant has finished generating */
      type: "assistantFinished";
      runId: string;
    }
  | {
      /** Run completion: indicates overall run has finished successfully */
      type: "runFinished";
      runId: string;
    }
  | {
      /** Run failure: indicates run encountered an error */
      type: "runFailed";
      runId: string;
      message: string;
    }
  | {
      type: "runInterrupted";
      runId: string;
      conversationId: string;
      task: string;
    }
  | {
      /** Conversation start: signals beginning of a conversation turn */
      type: "conversationStarted";
      conversationId: string;
      runId: string;
      userMessage: string;
    }
  | {
      /** 收到 webviewReady 后，把上一次未结束的对话推给 webview */
      type: "conversationRestored";
      conversationId: string;
      messages: ChatMessage[];
    }
  | {
      /** 推送历史对话列表，供"历史"菜单渲染 */
      type: "conversationList";
      conversations: ConversationSummary[];
    };
