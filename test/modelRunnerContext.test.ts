import { describe, expect, it } from "vitest";

import { createModelRunner } from "../src/extension/model/modelRunner";
import type { ModelMessage, ModelProvider } from "../src/extension/model/types";
import type { HostToWebviewMessage } from "../src/shared/messages";

async function collectHostMessages(
  runner: ReturnType<typeof createModelRunner>,
  task: string,
): Promise<HostToWebviewMessage[]> {
  const messages: HostToWebviewMessage[] = [];

  for await (const message of runner.run({
    runId: "run-1",
    task,
    signal: new AbortController().signal,
  })) {
    messages.push(message);
  }

  return messages;
}

describe("createModelRunner runtime context", () => {
  it("adds a dynamic runtime context system message for each run", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test Model",
      stream: async function* ({ messages }) {
        capturedMessages.push(messages);
        yield { type: "contentDelta", content: "ok" };
      },
    };

    const runner = createModelRunner({
      provider,
      systemPrompt: "Base system prompt.",
      systemPromptProvider: async () => "Runtime context prompt.",
    });

    const hostMessages = await collectHostMessages(runner, "Inspect workspace");

    expect(capturedMessages).toEqual([
      [
        { role: "system", content: "Base system prompt." },
        { role: "system", content: "Runtime context prompt." },
        { role: "user", content: "Inspect workspace" },
      ],
    ]);
    expect(hostMessages).toContainEqual({
      type: "assistantThinking",
      runId: "run-1",
      message: "Building code context",
    });
    expect(hostMessages).toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "ok",
    });
  });

  it("does not add an empty runtime context system message", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test Model",
      stream: async function* ({ messages }) {
        capturedMessages.push(messages);
      },
    };

    const runner = createModelRunner({
      provider,
      systemPromptProvider: () => "  ",
    });

    await collectHostMessages(runner, "No active editor");

    expect(capturedMessages).toEqual([[{ role: "user", content: "No active editor" }]]);
  });

  it("continues without runtime context when the context provider fails", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const provider: ModelProvider = {
      id: "test",
      displayName: "Test Model",
      stream: async function* ({ messages }) {
        capturedMessages.push(messages);
        yield { type: "contentDelta", content: "fallback ok" };
      },
    };

    const runner = createModelRunner({
      provider,
      systemPrompt: "Base system prompt.",
      systemPromptProvider: async () => {
        throw new Error("context failed");
      },
    });

    const hostMessages = await collectHostMessages(runner, "Inspect without context");

    expect(capturedMessages).toEqual([
      [
        { role: "system", content: "Base system prompt." },
        { role: "user", content: "Inspect without context" },
      ],
    ]);
    expect(hostMessages).toContainEqual({
      type: "assistantThinking",
      runId: "run-1",
      message: "Code context unavailable",
    });
    expect(hostMessages).toContainEqual({
      type: "assistantDelta",
      runId: "run-1",
      content: "fallback ok",
    });
  });
});
