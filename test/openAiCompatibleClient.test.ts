import { describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleClient } from "../src/extension/model/openAiCompatibleClient";
import { ModelProviderError } from "../src/extension/model/types";

async function collectEvents(client: ReturnType<typeof createOpenAiCompatibleClient>) {
  const events = [];

  for await (const event of client.stream({
    messages: [{ role: "user", content: "Hello" }],
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  return events;
}

describe("createOpenAiCompatibleClient", () => {
  it("posts an OpenAI-compatible streaming chat request and parses SSE deltas", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        [
          'data: {"choices":[{"delta":{"reasoning_content":"checking"}}]}',
          "",
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          "",
          'data: {"choices":[{"delta":{"content":" there"}}]}',
          "",
          'data: {"usage":{"total_tokens":3},"choices":[]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200 },
      ),
    );

    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-api-key",
      model: "deepseek-v4-flash",
      fetch: fetchMock,
      body: {
        thinking: { type: "disabled" },
      },
    });

    await expect(collectEvents(client)).resolves.toEqual([
      { type: "reasoningDelta", content: "checking" },
      { type: "contentDelta", content: "Hello" },
      { type: "contentDelta", content: " there" },
      { type: "usage", usage: { total_tokens: 3 } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");

    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "disabled" },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("sends tool definitions and history and streams tool call deltas", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exploreCode","arguments":"{\\"query\\":"}}]}}]}',
          "",
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"provider registry\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200 },
      ),
    );
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-api-key",
      model: "deepseek-v4-flash",
      fetch: fetchMock,
    });
    const tool = {
      type: "function" as const,
      function: {
        name: "exploreCode",
        description: "Search the current workspace code.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    };
    const events = [];

    for await (const event of client.stream({
      messages: [
      {
        role: "assistant",
        content: "",
        reasoningContent: "Checking the model runner.",
        toolCalls: [
            {
              id: "call_0",
              type: "function",
              function: { name: "exploreCode", arguments: '{"query":"model runner"}' },
            },
          ],
        },
        { role: "tool", content: "model runner context", toolCallId: "call_0", name: "exploreCode" },
        { role: "user", content: "Where is the provider registry?" },
      ],
      signal: new AbortController().signal,
      tools: [tool],
      toolChoice: "auto",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "toolCallDelta",
        index: 0,
        id: "call_1",
        name: "exploreCode",
        argumentsDelta: '{"query":',
      },
      { type: "toolCallDelta", index: 0, argumentsDelta: '"provider registry"}' },
      { type: "finishReason", reason: "tool_calls" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toBe("auto");
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_content: "Checking the model runner.",
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "exploreCode", arguments: '{"query":"model runner"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "model runner context",
        tool_call_id: "call_0",
        name: "exploreCode",
      },
      { role: "user", content: "Where is the provider registry?" },
    ]);
  });

  it.each([
    [401, "authentication_failed"],
    [402, "insufficient_balance"],
    [422, "invalid_parameters"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_overloaded"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("request failed", { status }));
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-api-key",
      model: "deepseek-v4-flash",
      fetch: fetchMock,
    });

    const result = collectEvents(client);

    await expect(result).rejects.toBeInstanceOf(ModelProviderError);
    await expect(result).rejects.toMatchObject({ code });
  });
});
