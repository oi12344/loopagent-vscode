export type ModelProviderId = "fake" | "deepseek";

export type ModelThinkingMode = "disabled" | "enabled";

export type TaskMode = "ask" | "edit";

export type RunModelSelection = {
  provider: ModelProviderId;
  model: string;
  thinking: ModelThinkingMode;
};

export type WebviewToHostMessage = {
  type: "startTask";
  task: string;
  mode?: TaskMode;
  model?: RunModelSelection;
};

export type HostToWebviewMessage =
  | {
      type: "runStarted";
      runId: string;
      task: string;
    }
  | {
      type: "agentEvent";
      runId: string;
      message: string;
    }
  | {
      type: "assistantStarted";
      runId: string;
      provider: string;
    }
  | {
      type: "assistantThinking";
      runId: string;
      message: string;
    }
  | {
      type: "assistantReasoningDelta";
      runId: string;
      content: string;
    }
  | {
      type: "assistantDelta";
      runId: string;
      content: string;
    }
  | {
      type: "assistantFinished";
      runId: string;
    }
  | {
      type: "runFinished";
      runId: string;
    }
  | {
      type: "runFailed";
      runId: string;
      message: string;
    };
