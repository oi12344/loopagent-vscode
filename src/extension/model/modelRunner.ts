import type { HostToWebviewMessage } from "../../shared/messages";
import type { ModelMessage, ModelProvider, ModelRequest } from "./types";

export type ModelRunRequest = {
  runId: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  tools?: ModelRequest["tools"];
  toolChoice?: ModelRequest["toolChoice"];
};

export type ModelRunner = {
  run(request: ModelRunRequest): AsyncIterable<HostToWebviewMessage>;
};

export type PostHostMessage = (message: HostToWebviewMessage) => boolean | void | PromiseLike<boolean | void>;

export type StartModelRunOptions = {
  runner: ModelRunner;
  postMessage: PostHostMessage;
  messages: ModelMessage[];
  runId?: string;
  signal: AbortSignal;
  tools?: ModelRequest["tools"];
  toolChoice?: ModelRequest["toolChoice"];
};

export type ModelRunHandle = {
  runId: string;
  done: Promise<void>;
};

export function startModelRun({
  runner,
  postMessage,
  messages,
  runId = createRunId(),
  signal,
  tools,
  toolChoice,
}: StartModelRunOptions): ModelRunHandle {
  const request: ModelRunRequest = {
    runId,
    messages,
    signal,
    tools,
    toolChoice,
  };

  const done = pumpRunMessages(runner, request, postMessage);

  return {
    runId,
    done,
  };
}

async function pumpRunMessages(
  runner: ModelRunner,
  request: ModelRunRequest,
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

  return "Model run failed";
}

export function createModelRunner(provider: ModelProvider, providerName?: string): ModelRunner {
  return {
    async *run({ runId, messages, signal, tools, toolChoice }) {
      yield { type: "assistantStarted", runId, provider: providerName ?? provider.displayName } satisfies HostToWebviewMessage;

      for await (const event of provider.stream({
        messages,
        signal,
        tools,
        toolChoice,
      })) {
        if (signal.aborted) {
          return;
        }

        if (event.type === "reasoningDelta") {
          yield { type: "assistantReasoningDelta", runId, content: event.content } satisfies HostToWebviewMessage;
        } else if (event.type === "contentDelta") {
          yield { type: "assistantDelta", runId, content: event.content } satisfies HostToWebviewMessage;
        }
      }

      yield { type: "assistantFinished", runId } satisfies HostToWebviewMessage;
    },
  };
}
