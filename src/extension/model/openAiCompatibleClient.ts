import { ModelProviderError, type ModelMessage, type ModelProvider, type ModelRequest } from "./types";

type OpenAiCompatibleClientOptions = {
  id?: string;
  displayName?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  body?: Record<string, unknown>;
};

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
};

export function createOpenAiCompatibleClient({
  id = "openai-compatible",
  displayName,
  baseUrl,
  apiKey,
  model,
  fetch: fetchImpl = fetch,
  body = {},
}: OpenAiCompatibleClientOptions): ModelProvider {
  return {
    id,
    displayName: displayName ?? model,
    stream(request) {
      return streamChatCompletion({ baseUrl, apiKey, model, fetchImpl, body, request });
    },
  };
}

async function* streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  fetchImpl,
  body,
  request,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  body: Record<string, unknown>;
  request: ModelRequest;
}) {
  const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: request.messages.map(serializeMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools
        ? {
            tools: request.tools,
            tool_choice: request.toolChoice ?? "auto",
          }
        : {}),
      ...body,
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    throw await createHttpError(response);
  }

  if (!response.body) {
    throw new ModelProviderError("request_failed", "Model response did not include a readable body");
  }

  for await (const chunk of parseServerSentEvents(response.body)) {
    if (request.signal.aborted) {
      return;
    }

    if (chunk === "[DONE]") {
      return;
    }

    const parsedChunk = parseChunk(chunk);
    for (const event of mapChunkEvents(parsedChunk)) {
      yield event;
    }
  }
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  switch (message.role) {
    case "assistant":
      return {
        role: message.role,
        content: message.content,
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
      };
    case "tool":
      return {
        role: message.role,
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      };
    default:
      return message;
  }
}

async function createHttpError(response: Response): Promise<ModelProviderError> {
  const message = await readErrorMessage(response);

  switch (response.status) {
    case 401:
      return new ModelProviderError("authentication_failed", "DeepSeek API authentication failed", response.status);
    case 402:
      return new ModelProviderError("insufficient_balance", "DeepSeek account balance is insufficient", response.status);
    case 422:
      return new ModelProviderError("invalid_parameters", `DeepSeek rejected the request parameters: ${message}`, response.status);
    case 429:
      return new ModelProviderError("rate_limited", "DeepSeek rate limit reached", response.status);
    case 500:
      return new ModelProviderError("server_error", "DeepSeek server returned an error", response.status);
    case 503:
      return new ModelProviderError("server_overloaded", "DeepSeek server is overloaded", response.status);
    default:
      return new ModelProviderError("request_failed", `Model request failed with HTTP ${response.status}: ${message}`, response.status);
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || response.statusText || "request failed";
  } catch {
    return response.statusText || "request failed";
  }
}

async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = findEventSeparator(buffer);

    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + getSeparatorLength(buffer, separatorIndex));
      const data = extractEventData(rawEvent);

      if (data.length > 0) {
        yield data;
      }

      separatorIndex = findEventSeparator(buffer);
    }
  }

  buffer += decoder.decode();
  const data = extractEventData(buffer);

  if (data.length > 0) {
    yield data;
  }
}

function findEventSeparator(buffer: string): number {
  const windowsIndex = buffer.indexOf("\r\n\r\n");
  const unixIndex = buffer.indexOf("\n\n");

  if (windowsIndex === -1) {
    return unixIndex;
  }

  if (unixIndex === -1) {
    return windowsIndex;
  }

  return Math.min(windowsIndex, unixIndex);
}

function getSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function extractEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
}

function parseChunk(chunk: string): ChatCompletionChunk {
  try {
    return JSON.parse(chunk) as ChatCompletionChunk;
  } catch (error) {
    throw new ModelProviderError("request_failed", `Could not parse model stream chunk: ${String(error)}`);
  }
}

function* mapChunkEvents(chunk: ChatCompletionChunk) {
  for (const choice of chunk.choices ?? []) {
    const reasoningContent = choice.delta?.reasoning_content;
    if (reasoningContent) {
      yield { type: "reasoningDelta" as const, content: reasoningContent };
    }

    const content = choice.delta?.content;
    if (content) {
      yield { type: "contentDelta" as const, content };
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      yield {
        type: "toolCallDelta" as const,
        index: toolCall.index,
        ...(toolCall.id ? { id: toolCall.id } : {}),
        ...(toolCall.function?.name ? { name: toolCall.function.name } : {}),
        ...(toolCall.function?.arguments !== undefined
          ? { argumentsDelta: toolCall.function.arguments }
          : {}),
      };
    }

    if (choice.finish_reason) {
      yield { type: "finishReason" as const, reason: choice.finish_reason };
    }
  }

  if (chunk.usage) {
    yield { type: "usage" as const, usage: chunk.usage };
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
