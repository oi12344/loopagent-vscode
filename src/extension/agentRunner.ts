import type { HostToWebviewMessage } from "../shared/messages";

export type AgentRunRequest = {
  runId: string;
  task: string;
  signal: AbortSignal;
};

export type AgentRunner = {
  run(request: AgentRunRequest): AsyncIterable<HostToWebviewMessage>;
};

export type PostHostMessage = (message: HostToWebviewMessage) => boolean | void | PromiseLike<boolean | void>;

export type StartAgentRunOptions = {
  task: string;
  runner: AgentRunner;
  postMessage: PostHostMessage;
  runId?: string;
};

export type AgentRunHandle = {
  runId: string;
  cancel(): void;
  done: Promise<void>;
};

export function startAgentRun({ task, runner, postMessage, runId = createRunId() }: StartAgentRunOptions): AgentRunHandle {
  const abortController = new AbortController();
  const request: AgentRunRequest = {
    runId,
    task,
    signal: abortController.signal,
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
  runner: AgentRunner,
  request: AgentRunRequest,
  postMessage: PostHostMessage,
): Promise<void> {
  try {
    for await (const message of runner.run(request)) {
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
