import { describe, expect, it } from "vitest";

import { evaluateTimeoutAdjustment } from "../../src/extension/agent/workflow/adaptiveTimeout";
import type { HostToWebviewMessage } from "../../src/shared/messages";

describe("evaluateTimeoutAdjustment", () => {
  describe("Strategy 1: High tool diversity", () => {
    it("suggests 1.5x multiplier for high diversity (≥60%)", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "exploreCode", input: "find auth" },
        { type: "toolCallStarted", runId: "r1", callId: "c2", toolName: "readFile", input: "auth.ts" },
        { type: "toolCallStarted", runId: "r1", callId: "c3", toolName: "browseSymbols", input: "UserAuth" },
        { type: "toolCallStarted", runId: "r1", callId: "c4", toolName: "applyEdit", input: "fix bug" },
        { type: "toolCallStarted", runId: "r1", callId: "c5", toolName: "runCommand", input: "npm test" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(1.5);
      expect(result.shouldExtend).toBe(true);
      expect(result.reason).toContain("diversity");
    });

    it("requires at least 3 tool calls for diversity strategy", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "exploreCode", input: "find" },
        { type: "toolCallStarted", runId: "r1", callId: "c2", toolName: "readFile", input: "file" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      // Should not trigger high diversity strategy (needs ≥3 calls)
      expect(result.suggestedMultiplier).toBe(1.0);
    });
  });

  describe("Strategy 2: Low tool diversity (repetition)", () => {
    it("suggests 0.8x multiplier for low diversity (<30%)", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "readFile", input: "config.ts" },
        { type: "toolCallStarted", runId: "r1", callId: "c2", toolName: "readFile", input: "config.ts" },
        { type: "toolCallStarted", runId: "r1", callId: "c3", toolName: "readFile", input: "config.ts" },
        { type: "toolCallStarted", runId: "r1", callId: "c4", toolName: "readFile", input: "config.ts" },
        { type: "toolCallStarted", runId: "r1", callId: "c5", toolName: "readFile", input: "config.ts" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(0.8);
      expect(result.shouldExtend).toBe(false);
      expect(result.reason).toContain("diversity");
    });
  });

  describe("Strategy 3: Long-running tools", () => {
    it("suggests 2.0x multiplier for npm test", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "agentEvent", runId: "r1", message: "starting" },
        { type: "agentEvent", runId: "r1", message: "working" },
        { type: "agentEvent", runId: "r1", message: "preparing" },
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "runCommand", input: "npm test" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(2.0);
      expect(result.shouldExtend).toBe(true);
      expect(result.reason).toContain("long-running");
    });

    it("suggests 2.0x multiplier for npm run build", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "agentEvent", runId: "r1", message: "starting" },
        { type: "agentEvent", runId: "r1", message: "working" },
        { type: "agentEvent", runId: "r1", message: "preparing" },
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "runCommand", input: "npm run build" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(2.0);
      expect(result.shouldExtend).toBe(true);
    });

    it("detects yarn test as long-running", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "agentEvent", runId: "r1", message: "starting" },
        { type: "agentEvent", runId: "r1", message: "working" },
        { type: "agentEvent", runId: "r1", message: "preparing" },
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "runCommand", input: "yarn test" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(2.0);
    });

    it("does not trigger for short commands", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "agentEvent", runId: "r1", message: "starting" },
        { type: "agentEvent", runId: "r1", message: "working" },
        { type: "agentEvent", runId: "r1", message: "preparing" },
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "runCommand", input: "ls -la" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(1.0);
    });
  });

  describe("Strategy 4: Consistent progress", () => {
    it("suggests 1.2x multiplier for consistent progress pattern", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "assistantThinking", runId: "r1", message: "planning" },
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "exploreCode", input: "find" },
        { type: "agentEvent", runId: "r1", message: "exploring" },
        { type: "toolCallStarted", runId: "r1", callId: "c2", toolName: "readFile", input: "file" },
        { type: "assistantThinking", runId: "r1", message: "analyzing" },
        { type: "toolCallStarted", runId: "r1", callId: "c3", toolName: "applyEdit", input: "edit" },
        { type: "agentEvent", runId: "r1", message: "applying" },
        { type: "assistantThinking", runId: "r1", message: "verifying" },
        { type: "toolCallStarted", runId: "r1", callId: "c4", toolName: "runCommand", input: "test" },
        { type: "agentEvent", runId: "r1", message: "done" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(1.2);
      expect(result.shouldExtend).toBe(true);
      expect(result.reason).toContain("progress");
    });
  });

  describe("Strategy priority and defaults", () => {
    it("returns 1.0 multiplier when no strategy triggers", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "agentEvent", runId: "r1", message: "starting" },
        { type: "agentEvent", runId: "r1", message: "working" },
        { type: "agentEvent", runId: "r1", message: "done" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(1.0);
      expect(result.shouldExtend).toBe(false);
    });

    it("handles empty message array", () => {
      const result = evaluateTimeoutAdjustment([]);
      expect(result.suggestedMultiplier).toBe(1.0);
      expect(result.shouldExtend).toBe(false);
    });

    it("handles very few messages", () => {
      const messages: HostToWebviewMessage[] = [
        { type: "agentEvent", runId: "r1", message: "starting" },
      ];

      const result = evaluateTimeoutAdjustment(messages);
      expect(result.suggestedMultiplier).toBe(1.0);
      expect(result.reason).toContain("Too few");
    });
  });

  describe("Recent window behavior", () => {
    it("analyzes only the last 5 tool calls for diversity", () => {
      const oldMessages: HostToWebviewMessage[] = [
        { type: "toolCallStarted", runId: "r1", callId: "c1", toolName: "readFile", input: "a" },
        { type: "toolCallStarted", runId: "r1", callId: "c2", toolName: "readFile", input: "b" },
        { type: "toolCallStarted", runId: "r1", callId: "c3", toolName: "readFile", input: "c" },
      ];

      const recentMessages: HostToWebviewMessage[] = [
        { type: "toolCallStarted", runId: "r1", callId: "c4", toolName: "exploreCode", input: "d" },
        { type: "toolCallStarted", runId: "r1", callId: "c5", toolName: "browseSymbols", input: "e" },
        { type: "toolCallStarted", runId: "r1", callId: "c6", toolName: "applyEdit", input: "f" },
        { type: "toolCallStarted", runId: "r1", callId: "c7", toolName: "runCommand", input: "g" },
        { type: "toolCallStarted", runId: "r1", callId: "c8", toolName: "readFile", input: "h" },
      ];

      const result = evaluateTimeoutAdjustment([...oldMessages, ...recentMessages]);
      // Last 5 calls have 5 unique tools = 100% diversity
      expect(result.suggestedMultiplier).toBe(1.5);
      expect(result.shouldExtend).toBe(true);
    });
  });
});
