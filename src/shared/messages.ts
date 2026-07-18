import type { ChatMessage } from "./chatTypes";

/** AI 模型提供商标识 */
export type ModelProviderId = "fake" | "deepseek";

/** 模型思维模式 */
export type ModelThinkingMode = "disabled" | "enabled";

/** 任务执行模式 */
export type TaskMode = "ask" | "edit";

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
      task: string;
      mode?: TaskMode;
      model?: RunModelSelection;
    }
  | {
      type: "continueConversation";
      conversationId: string;
      userMessage: string;
      mode?: TaskMode;
      model?: RunModelSelection;
    }
  | {
      /** Webview 挂载完成，可以安全接收恢复消息了 */
      type: "webviewReady";
    }
  | {
      /** 用户点击"新对话"，清空当前活跃对话 */
      type: "newConversation";
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
    };
