import { describe, expect, it } from "vitest";

import { startAgentRun, type AgentRunner, type AgentRunRequest } from "../../src/extension/agentRunner";
import { createConversationStore } from "../../src/extension/conversation/conversationStore";
import { createConversationManager } from "../../src/extension/conversation/conversationManager";

describe("Multi-turn conversation integration", () => {
  it("supports starting a new conversation and continuing it with history", async () => {
    const conversationStore = createConversationStore();
    const conversationManager = createConversationManager(conversationStore);

    // First turn: start conversation with user message
    const conversation = conversationManager.startConversation();
    conversationManager.addUserMessage(conversation.conversationId, "What is TypeScript?");

    const firstRunHistory = conversationManager.getConversationHistory(conversation.conversationId);
    expect(firstRunHistory).toHaveLength(1);

    // Simulate backend: add assistant response
    conversationManager.addAssistantMessage(conversation.conversationId, "TypeScript is a typed superset of JavaScript.");

    // Second turn: continue conversation
    conversationManager.addUserMessage(conversation.conversationId, "Tell me more");
    const secondRunHistory = conversationManager.getConversationHistory(conversation.conversationId);

    // Verify conversation history grows correctly
    expect(secondRunHistory).toHaveLength(3);
    expect(secondRunHistory[0]).toEqual({ role: "user", content: "What is TypeScript?" });
    expect(secondRunHistory[1]).toEqual({ role: "assistant", content: "TypeScript is a typed superset of JavaScript." });
    expect(secondRunHistory[2]).toEqual({ role: "user", content: "Tell me more" });
  });

  it("passes conversation history through startAgentRun", async () => {
    const conversationHistory = [
      { role: "user" as const, content: "First question" },
      { role: "assistant" as const, content: "First answer" },
    ];

    let capturedRequest: AgentRunRequest | undefined;
    const runner: AgentRunner = {
      run: async function* (request) {
        capturedRequest = request;
        yield { type: "runStarted", runId: request.runId, task: request.task };
        yield { type: "runFinished", runId: request.runId };
      },
    };

    const handle = startAgentRun({
      task: "Continue the conversation",
      runner,
      postMessage: () => undefined,
      conversationHistory,
    });

    await handle.done;

    expect(capturedRequest?.conversationHistory).toEqual(conversationHistory);
  });

  it("maintains separate conversations independently", () => {
    const conversationStore = createConversationStore();
    const conversationManager = createConversationManager(conversationStore);

    // First conversation
    const conv1 = conversationManager.startConversation();
    conversationManager.addUserMessage(conv1.conversationId, "What is Python?");
    const conv1History = conversationManager.getConversationHistory(conv1.conversationId);

    // Second conversation
    const conv2 = conversationManager.startConversation();
    conversationManager.addUserMessage(conv2.conversationId, "What is Rust?");
    const conv2History = conversationManager.getConversationHistory(conv2.conversationId);

    expect(conv1History).toEqual([{ role: "user", content: "What is Python?" }]);
    expect(conv2History).toEqual([{ role: "user", content: "What is Rust?" }]);
    expect(conv1.conversationId).not.toBe(conv2.conversationId);
  });

  it("preserves message order across turns", () => {
    const conversationStore = createConversationStore();
    const conversationManager = createConversationManager(conversationStore);

    const conversation = conversationManager.startConversation();
    conversationManager.addUserMessage(conversation.conversationId, "First user message");
    conversationManager.addAssistantMessage(conversation.conversationId, "First assistant response");
    conversationManager.addUserMessage(conversation.conversationId, "Second user message");
    conversationManager.addAssistantMessage(conversation.conversationId, "Second assistant response");

    const history = conversationManager.getConversationHistory(conversation.conversationId);

    expect(history).toEqual([
      { role: "user", content: "First user message" },
      { role: "assistant", content: "First assistant response" },
      { role: "user", content: "Second user message" },
      { role: "assistant", content: "Second assistant response" },
    ]);
  });

  it("handles non-existent conversation gracefully", () => {
    const conversationStore = createConversationStore();
    const conversationManager = createConversationManager(conversationStore);

    const history = conversationManager.getConversationHistory("non-existent-id");
    expect(history).toEqual([]);
  });
});
