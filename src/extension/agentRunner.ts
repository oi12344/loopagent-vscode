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
  let assistantStarted = false;
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
      if (message.type === "assistantStarted") assistantStarted = true;
    }
  } catch {
    if (request.signal.aborted) {
      return;
    }

    if (!assistantStarted) {
      await postMessage({ type: "assistantStarted", runId: request.runId, provider: "LoopAgent" });
    }
    await postMessage({ type: "assistantDelta", runId: request.runId, content: OUTER_RECOVERY_SUMMARY });
    await postMessage({ type: "assistantFinished", runId: request.runId });
    await postMessage({ type: "runFinished", runId: request.runId });
  }
}

const OUTER_RECOVERY_SUMMARY = [
  "任务未能完成。",
  "- 已完成：已保留错误发生前产生的进度。",
  "- 失败：执行流程发生内部错误，且当前无法调用恢复模型。",
  "- 剩余：未完成步骤仍需重新执行。",
  "- 下一步：请检查模型连接和配置后重试。",
].join("\n");

function createRunId(): string {
  return `run-${Date.now().toString(36)}`;
}
