import { describe, expect, it, vi } from "vitest";

import { createDeepSeekProvider } from "../src/extension/model/providers/deepseekProvider";
import { createModelRunner } from "../src/extension/model/modelRunner";
import type { ModelMessage, ModelProvider } from "../src/extension/model/types";
import type { HostToWebviewMessage } from "../src/shared/messages";

async function collectHostMessages(runner: ReturnType<typeof createModelRunner>, task: string): Promise<HostToWebviewMessage[]> {
  const messages: HostToWebviewMessage[] = [];

  for await (const message of runner.run({ runId: "run-1", task, signal: new AbortController().signal })) {
    messages.push(message);
  }

  return messages;
}

describe("createModelRunner", () => {
  it("turns provider stream events into structured assistant chat messages", async () => {
    let capturedMessages: ModelMessage[] = [];
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test Model",
      stream: async function* ({ messages }) {
        capturedMessages = messages;
        yield { type: "reasoningDelta", content: "private raw reasoning" };
        yield { type: "contentDelta", content: "The " };
        yield { type: "contentDelta", content: "workspace is ready." };
      },
    };

    const runner = createModelRunner({ provider });
    const hostMessages = await collectHostMessages(runner, "Inspect workspace");

    expect(capturedMessages).toEqual([{ role: "user", content: "Inspect workspace" }]);
    expect(hostMessages).toEqual([
      { type: "runStarted", runId: "run-1", task: "Inspect workspace" },
      { type: "assistantStarted", runId: "run-1", provider: "Test Model" },
      { type: "assistantThinking", runId: "run-1", message: "Calling Test Model" },
      { type: "assistantReasoningDelta", runId: "run-1", content: "private raw reasoning" },
      { type: "assistantDelta", runId: "run-1", content: "The " },
      { type: "assistantDelta", runId: "run-1", content: "workspace is ready." },
      { type: "assistantFinished", runId: "run-1" },
      { type: "runFinished", runId: "run-1" },
    ]);
    expect(hostMessages).toContainEqual({
      type: "assistantReasoningDelta",
      runId: "run-1",
      content: "private raw reasoning",
    });
  });
});

describe("createDeepSeekProvider", () => {
  it("enables thinking by default in the streaming request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: [DONE]\n\n", { status: 200 }));
    const provider = createDeepSeekProvider({
      apiKey: "test-api-key",
      fetch: fetchMock,
    });

    for await (const _event of provider.stream({
      messages: [{ role: "user", content: "Hello" }],
      signal: new AbortController().signal,
    })) {
      // This response contains no model events.
    }

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("fails before sending a request when the API key is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = createDeepSeekProvider({
      apiKey: "",
      fetch: fetchMock,
    });

    await expect(async () => {
      for await (const _event of provider.stream({
        messages: [{ role: "user", content: "Hello" }],
        signal: new AbortController().signal,
      })) {
        // The provider should throw before yielding anything.
      }
    }).rejects.toMatchObject({
      code: "missing_api_key",
      message: "DeepSeek API key is not configured",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
