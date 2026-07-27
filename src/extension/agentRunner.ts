import type { HostToWebviewMessage, MessageAttachment } from "../shared/messages";
import type { ChatMessage, InterruptedRunCheckpoint } from "../shared/chatTypes";
import type { ReactAgentMessage } from "./agent/reactTypes";

export type AgentRunRequest = {
  runId: string;
  task: string;
  signal: AbortSignal;
  conversationHistory?: ChatMessage[];
  initialMessages?: ReactAgentMessage[];
  requiredToolNames?: string[];
  conversationId?: string;
  resumeState?: AgentResumeState;
  /** 用户上传的附件（图片、文件等） */
  attachments?: MessageAttachment[];
};

export type AgentResumeState = { kind: "react"; checkpoint: InterruptedRunCheckpoint };

export type AgentRunner = {
  run(request: AgentRunRequest): AsyncIterable<HostToWebviewMessage>;
};

export type PostHostMessage = (message: HostToWebviewMessage) => boolean | void | PromiseLike<boolean | void>;

export type StartAgentRunOptions = {
  task: string;
  runner: AgentRunner | PromiseLike<AgentRunner>;
  postMessage: PostHostMessage;
  runId?: string;
  conversationHistory?: ChatMessage[];
  conversationId?: string;
  resumeState?: AgentResumeState;
  attachments?: MessageAttachment[];
};

export type AgentRunHandle = {
  runId: string;
  cancel(): void;
  done: Promise<void>;
};

export function startAgentRun({
  task,
  runner,
  postMessage,
  runId = createRunId(),
  conversationHistory,
  conversationId,
  resumeState,
  attachments,
}: StartAgentRunOptions): AgentRunHandle {
  const abortController = new AbortController();
  const request: AgentRunRequest = {
    runId,
    task,
    signal: abortController.signal,
    conversationHistory,
    conversationId,
    resumeState,
    attachments,
  };

  const done = pumpRunMessages(runner, request, postMessage);

  return {
    runId,
    cancel() {
      abortController.abort();
    },
    done,
  };
}

async function pumpRunMessages(
  runner: AgentRunner | PromiseLike<AgentRunner>,
  request: AgentRunRequest,
  postMessage: PostHostMessage,
): Promise<void> {
  try {
    const resolvedRunner = "then" in runner ? await runner : runner;
    if (request.signal.aborted) {
      return;
    }

    for await (const message of resolvedRunner.run(request)) {
      if (request.signal.aborted) {
        return;
      }

      await postMessage(message);
    }
  } catch (error) {
    if (request.signal.aborted) {
      return;
    }

    await postMessage({
      type: "runFailed",
      runId: request.runId,
      message: formatRunError(error),
    });
  }
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}`;
}

function formatRunError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Agent run failed";
}
