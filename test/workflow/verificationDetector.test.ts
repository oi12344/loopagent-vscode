import { describe, expect, it } from "vitest";

import { detectVerificationFromMessages, determineVerificationStatus } from "../../src/extension/agent/workflow/verificationDetector";
import type { HostToWebviewMessage } from "../../src/shared/messages";

describe("detectVerificationFromMessages", () => {
  it("detects test command and captures success", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "All tests passed",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationCommands).toContain("npm test");
    expect(result.verificationPassed).toBe(true);
  });

  it("detects test command failure", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "npm run test",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: false,
        output: "Test suite failed",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(false);
    expect(result.failureReason).toContain("npm run test");
  });

  it("detects typecheck command", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "npm run typecheck",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "No type errors",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationCommands).toContain("npm run typecheck");
    expect(result.verificationPassed).toBe(true);
  });

  it("detects tsc command as typecheck", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "tsc --noEmit",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("detects build command", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "npm run build",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "Build successful",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("detects multiple verification commands", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "Tests passed",
      },
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-2",
        toolName: "runCommand",
        input: "tsc --noEmit",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-2",
        succeeded: true,
        output: "",
      },
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-3",
        toolName: "runCommand",
        input: "npm run build",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-3",
        succeeded: true,
        output: "Build complete",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationCommands.length).toBe(3);
    expect(result.verificationPassed).toBe(true);
  });

  it("ignores unmatched toolCallFinished messages", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-orphan",
        succeeded: true,
        output: "Some output",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(false);
  });

  it("handles mixed verification and non-verification commands", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "ls -la",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "file list",
      },
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-2",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-2",
        succeeded: true,
        output: "Tests passed",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationCommands).toEqual(["npm test"]);
    expect(result.verificationPassed).toBe(true);
  });

  it("returns false for empty message array", () => {
    const result = detectVerificationFromMessages([]);
    expect(result.hasVerification).toBe(false);
    expect(result.verificationCommands).toEqual([]);
    expect(result.verificationPassed).toBe(false);
  });

  it("detects failure from agent event messages", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "Tests passed",
      },
      {
        type: "agentEvent",
        runId: "run-1",
        message: "Test suite failed with errors",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(false);
    expect(result.failureReason).toContain("failed");
  });

  it("detects vitest command as test", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "vitest run",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "Tests passed",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("detects jest command as test", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "jest",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "All tests passed",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("detects cargo test as verification", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "run-1",
        callId: "call-1",
        toolName: "runCommand",
        input: "cargo test",
      },
      {
        type: "toolCallFinished",
        runId: "run-1",
        callId: "call-1",
        succeeded: true,
        output: "Tests passed",
      },
    ];

    const result = detectVerificationFromMessages(messages);
    expect(result.hasVerification).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });
});

describe("determineVerificationStatus", () => {
  it("returns 'passed' when executor completes with verification", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c1",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "r1",
        callId: "c1",
        succeeded: true,
        output: "passed",
      },
    ];

    const result = determineVerificationStatus("executor", messages, "completed");
    expect(result.verificationStatus).toBe("passed");
  });

  it("returns 'failed' when verification commands fail", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c1",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "r1",
        callId: "c1",
        succeeded: false,
        output: "failed",
      },
    ];

    const result = determineVerificationStatus("executor", messages, "completed");
    expect(result.verificationStatus).toBe("failed");
    expect(result.verificationDetails).toContain("npm test");
  });

  it("returns 'not-run' when executor completes without verification", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "agentEvent",
        runId: "r1",
        message: "Working on task",
      },
    ];

    const result = determineVerificationStatus("executor", messages, "completed");
    expect(result.verificationStatus).toBe("not-run");
    expect(result.verificationDetails).toContain("No verification");
  });

  it("returns 'skipped' for non-executor roles", () => {
    const messages: HostToWebviewMessage[] = [];

    const result = determineVerificationStatus("explorer", messages, "completed");
    expect(result.verificationStatus).toBe("skipped");
    expect(result.verificationDetails).toContain("Non-executor");
  });

  it("returns 'skipped' when task failed", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c1",
        toolName: "runCommand",
        input: "npm test",
      },
    ];

    const result = determineVerificationStatus("executor", messages, "failed");
    expect(result.verificationStatus).toBe("skipped");
    expect(result.verificationDetails).toContain("did not complete");
  });

  it("returns 'skipped' when task was cancelled", () => {
    const messages: HostToWebviewMessage[] = [];

    const result = determineVerificationStatus("executor", messages, "cancelled");
    expect(result.verificationStatus).toBe("skipped");
  });

  it("handles mixed success and failure in multiple commands", () => {
    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c1",
        toolName: "runCommand",
        input: "npm test",
      },
      {
        type: "toolCallFinished",
        runId: "r1",
        callId: "c1",
        succeeded: true,
        output: "passed",
      },
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c2",
        toolName: "runCommand",
        input: "tsc --noEmit",
      },
      {
        type: "toolCallFinished",
        runId: "r1",
        callId: "c2",
        succeeded: false,
        output: "type errors",
      },
    ];

    const result = determineVerificationStatus("executor", messages, "completed");
    expect(result.verificationStatus).toBe("failed");
  });
});
