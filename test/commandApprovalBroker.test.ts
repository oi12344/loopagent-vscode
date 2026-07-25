import { describe, expect, it, vi } from "vitest";

import { createCommandApprovalBroker } from "../src/extension/agent/commandApprovalBroker";
import type { HostToWebviewMessage } from "../src/shared/messages";

describe("commandApprovalBroker", () => {
  it("falls back to the native approver when the webview is not visible", async () => {
    const fallbackApprove = vi.fn(async () => true);
    const postMessage = vi.fn();
    const broker = createCommandApprovalBroker({
      isWebviewVisible: () => false,
      postMessage,
      fallbackApprove,
    });

    const approved = await broker.approve({ command: "echo hi", cwd: "/repo", signal: new AbortController().signal });

    expect(approved).toBe(true);
    expect(fallbackApprove).toHaveBeenCalledWith({ command: "echo hi", cwd: "/repo", signal: expect.anything() });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts a commandApprovalRequested message and resolves when the webview responds", async () => {
    const messages: HostToWebviewMessage[] = [];
    const broker = createCommandApprovalBroker({
      isWebviewVisible: () => true,
      postMessage: (message) => messages.push(message),
      fallbackApprove: vi.fn(async () => false),
    });

    const approvalPromise = broker.approve({ command: "echo hi", cwd: "/repo", signal: new AbortController().signal });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "commandApprovalRequested", command: "echo hi", cwd: "/repo" });
    const approvalId = (messages[0] as { approvalId: string }).approvalId;
    expect(approvalId).toBeTruthy();

    broker.resolve(approvalId, true);
    await expect(approvalPromise).resolves.toBe(true);
  });

  it("resolves false when the caller's signal aborts while waiting", async () => {
    const messages: HostToWebviewMessage[] = [];
    const broker = createCommandApprovalBroker({
      isWebviewVisible: () => true,
      postMessage: (message) => messages.push(message),
      fallbackApprove: vi.fn(async () => false),
    });

    const controller = new AbortController();
    const approvalPromise = broker.approve({ command: "echo hi", cwd: "/repo", signal: controller.signal });
    controller.abort();

    await expect(approvalPromise).resolves.toBe(false);
  });

  it("ignores resolve calls for unknown or already-settled approval ids", async () => {
    const messages: HostToWebviewMessage[] = [];
    const broker = createCommandApprovalBroker({
      isWebviewVisible: () => true,
      postMessage: (message) => messages.push(message),
      fallbackApprove: vi.fn(async () => false),
    });

    expect(() => broker.resolve("unknown-id", true)).not.toThrow();

    const approvalPromise = broker.approve({ command: "echo hi", cwd: "/repo", signal: new AbortController().signal });
    const approvalId = (messages[0] as { approvalId: string }).approvalId;
    broker.resolve(approvalId, true);
    broker.resolve(approvalId, false);

    await expect(approvalPromise).resolves.toBe(true);
  });
});
