export type ModelProviderId = "fake" | "deepseek";

export type ModelThinkingMode = "disabled" | "enabled";

export type TaskMode = "ask" | "edit";

export type RunModelSelection = {
  provider: ModelProviderId;
  model: string;
  thinking: ModelThinkingMode;
};

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
    };
