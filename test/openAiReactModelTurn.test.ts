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

const readFileTool: ReactAgentTool = {
  name: "readFile",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  invoke: async () => "unused",
};

const applyEditTool: ReactAgentTool = {
  name: "applyEdit",
  description: "Apply edits.",
  inputSchema: { type: "object", properties: { changes: { type: "array" } }, required: ["changes"], additionalProperties: false },
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

  it("preserves streamed reasoning for the runner and follow-up tool history", async () => {
    const modelTurn = createOpenAiReactModelTurn({
      provider: createProvider([
        { type: "reasoningDelta", content: "Inspecting the workspace. " },
        { type: "reasoningDelta", content: "Searching the symbol." },
        { type: "toolCallDelta", index: 0, id: "call_1", name: "exploreCode", argumentsDelta: '{"query":"symbol"}' },
        { type: "finishReason", reason: "tool_calls" },
      ]),
      tools: [exploreCodeTool],
    });

    await expect(
      modelTurn({ messages: [{ role: "user", content: "Where is it?" }], signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      kind: "toolRequests",
      reasoning: "Inspecting the workspace. Searching the symbol.",
      assistantMessage: {
        role: "assistant",
        reasoningContent: "Inspecting the workspace. Searching the symbol.",
      },
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

  it("rejects final text when the provider was required to call a tool", async () => {
    const modelTurn = createOpenAiReactModelTurn({
      provider: createProvider([
        { type: "contentDelta", content: "I changed the file." },
        { type: "finishReason", reason: "stop" },
      ]),
      tools: [exploreCodeTool],
    });

    await expect(
      modelTurn({
        messages: [{ role: "user", content: "Change the file." }],
        signal: new AbortController().signal,
        toolChoice: "required",
      }),
    ).rejects.toThrow("Model did not call a required tool");
  });

  it("includes tool definitions with the default auto choice", async () => {
    let seenToolChoice: "auto" | "none" | undefined;
    let seenTools: unknown;
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test",
      async *stream(request) {
        seenToolChoice = request.toolChoice;
        seenTools = request.tools;
        yield { type: "contentDelta", content: "Final answer." } as const;
        yield { type: "finishReason", reason: "stop" } as const;
      },
    };
    const modelTurn = createOpenAiReactModelTurn({ provider, tools: [exploreCodeTool] });

    await modelTurn({ messages: [{ role: "user", content: "Status?" }], signal: new AbortController().signal });

    expect(seenToolChoice).toBe("auto");
    expect(seenTools).toEqual([
      {
        type: "function",
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
      },
    ]);
  });

  it("only exposes the forced tool when tool choice targets a specific function", async () => {
    let seenTools: Array<{ function: { name: string } }> | undefined;
    let seenToolChoice: unknown;
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test",
      async *stream(request) {
        seenTools = request.tools as Array<{ function: { name: string } }>;
        seenToolChoice = request.toolChoice;
        yield { type: "toolCallDelta", index: 0, id: "call_1", name: "applyEdit", argumentsDelta: '{"changes":[]}' } as const;
        yield { type: "finishReason", reason: "tool_calls" } as const;
      },
    };
    const modelTurn = createOpenAiReactModelTurn({ provider, tools: [readFileTool, exploreCodeTool, applyEditTool] });

    await modelTurn({
      messages: [{ role: "user", content: "Edit the file." }],
      signal: new AbortController().signal,
      toolChoice: { type: "function", function: { name: "applyEdit" } },
    });

    // 只暴露被强制的工具，防止模型改调其它工具（DeepSeek 不严格遵守 tool_choice 的具体函数约束）。
    expect(seenTools?.map((tool) => tool.function.name)).toEqual(["applyEdit"]);
    expect(seenToolChoice).toEqual({ type: "function", function: { name: "applyEdit" } });
  });

  it("passes the requested tool choice to the provider", async () => {
    let seenToolChoice: "auto" | "none" | undefined;
    let seenTools: unknown;
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test",
      async *stream(request) {
        seenToolChoice = request.toolChoice;
        seenTools = request.tools;
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
    expect(seenTools).toBeUndefined();
  });

  it("returns invalid JSON tool arguments for recoverable feedback", async () => {
    const modelTurn = createOpenAiReactModelTurn({
      provider: createProvider([
        { type: "toolCallDelta", index: 0, id: "call_1", name: "exploreCode", argumentsDelta: "{" },
        { type: "finishReason", reason: "tool_calls" },
      ]),
      tools: [exploreCodeTool],
    });

    await expect(
      modelTurn({ messages: [{ role: "user", content: "Status?" }], signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      kind: "toolRequests",
      requests: [{
        id: "call_1",
        name: "exploreCode",
        rawArguments: "{",
        input: undefined,
        parseError: "Invalid JSON arguments for tool exploreCode",
      }],
    });
  });

  it.each([
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
