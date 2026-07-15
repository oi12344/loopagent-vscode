import { describe, expect, it } from "vitest";
import { createOpenAiReactModelTurn } from "../src/extension/agent/openAiReactModelTurn";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { ModelProvider, ModelStreamEvent } from "../src/extension/model/types";

const exploreCodeTool: ReactAgentTool = {
  name: "exploreCode",
  description: "Search the current workspace code.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  invoke: async () => "unused",
};

function createProvider(events: ModelStreamEvent[]): ModelProvider {
  return {
    id: "test",
    displayName: "Test",
    async *stream() {
      yield* events;
    },
  };
}

describe("createOpenAiReactModelTurn", () => {
  it("aggregates streamed tool calls and preserves the assistant message", async () => {
    const modelTurn = createOpenAiReactModelTurn({
      provider: createProvider([
        { type: "toolCallDelta", index: 0, id: "call_1", name: "exploreCode", argumentsDelta: '{"query":' },
        { type: "toolCallDelta", index: 0, argumentsDelta: '"provider registry"}' },
        { type: "finishReason", reason: "tool_calls" },
      ]),
      tools: [exploreCodeTool],
    });

    await expect(
      modelTurn({ messages: [{ role: "user", content: "Where is it?" }], signal: new AbortController().signal }),
    ).resolves.toEqual({
      kind: "toolRequests",
      assistantMessage: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "exploreCode", arguments: '{"query":"provider registry"}' },
          },
        ],
      },
      requests: [
        {
          id: "call_1",
          name: "exploreCode",
          rawArguments: '{"query":"provider registry"}',
          input: { query: "provider registry" },
        },
      ],
    });
  });

  it("returns concatenated final text", async () => {
    const modelTurn = createOpenAiReactModelTurn({
      provider: createProvider([
        { type: "contentDelta", content: "Workspace " },
        { type: "contentDelta", content: "ready." },
        { type: "finishReason", reason: "stop" },
      ]),
      tools: [exploreCodeTool],
    });

    await expect(
      modelTurn({ messages: [{ role: "user", content: "Status?" }], signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: "final", content: "Workspace ready." });
  });

  it("passes the requested tool choice to the provider", async () => {
    let seenToolChoice: "auto" | "none" | undefined;
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test",
      async *stream(request) {
        seenToolChoice = request.toolChoice;
        yield { type: "contentDelta", content: "Final answer." } as const;
        yield { type: "finishReason", reason: "stop" } as const;
      },
    };
    const modelTurn = createOpenAiReactModelTurn({ provider, tools: [exploreCodeTool] });

    await modelTurn({
      messages: [{ role: "user", content: "Status?" }],
      signal: new AbortController().signal,
      toolChoice: "none",
    });

    expect(seenToolChoice).toBe("none");
  });

  it.each([
    {
      name: "invalid JSON arguments",
      events: [
        { type: "toolCallDelta", index: 0, id: "call_1", name: "exploreCode", argumentsDelta: "{" },
        { type: "finishReason", reason: "tool_calls" },
      ] satisfies ModelStreamEvent[],
      message: "Invalid JSON arguments for tool exploreCode",
    },
    {
      name: "duplicate tool call IDs",
      events: [
        { type: "toolCallDelta", index: 0, id: "call_1", name: "exploreCode", argumentsDelta: "{}" },
        { type: "toolCallDelta", index: 1, id: "call_1", name: "exploreCode", argumentsDelta: "{}" },
        { type: "finishReason", reason: "tool_calls" },
      ] satisfies ModelStreamEvent[],
      message: "Duplicate tool call id: call_1",
    },
    {
      name: "empty response",
      events: [] satisfies ModelStreamEvent[],
      message: "Model response was empty",
    },
  ])("rejects $name", async ({ events, message }) => {
    const modelTurn = createOpenAiReactModelTurn({ provider: createProvider(events), tools: [exploreCodeTool] });

    await expect(
      modelTurn({ messages: [{ role: "user", content: "Status?" }], signal: new AbortController().signal }),
    ).rejects.toThrow(message);
  });
});
