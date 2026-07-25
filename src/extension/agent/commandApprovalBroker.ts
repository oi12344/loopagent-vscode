import { randomUUID } from "node:crypto";

import type { HostToWebviewMessage } from "../../shared/messages";
import type { RunCommandApprovalRequest, RunCommandApprover } from "./runCommandTool";

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export type CommandApprovalBrokerHost = {
  /** 面板当前是否可见；不可见时直接走原生弹窗，不发 webview 卡片 */
  isWebviewVisible(): boolean;
  postMessage(message: HostToWebviewMessage): void;
  /** 面板不可见（或超时）时的兜底，通常是原生 showWarningMessage 模态框 */
  fallbackApprove: RunCommandApprover;
};

export type CommandApprovalBroker = {
  approve: RunCommandApprover;
  /** 收到 webview 的 commandApprovalResolved 消息时调用 */
  resolve(approvalId: string, approved: boolean): void;
};

export function createCommandApprovalBroker(host: CommandApprovalBrokerHost): CommandApprovalBroker {
  const pending = new Map<string, (approved: boolean) => void>();

  return {
    async approve(request: RunCommandApprovalRequest): Promise<boolean> {
      if (!host.isWebviewVisible()) {
        return host.fallbackApprove(request);
      }

      const approvalId = randomUUID();
      return new Promise<boolean>((resolvePromise) => {
        let settled = false;
        const settle = (approved: boolean) => {
          if (settled) return;
          settled = true;
          pending.delete(approvalId);
          clearTimeout(timer);
          request.signal.removeEventListener("abort", onAbort);
          resolvePromise(approved);
        };

        const onAbort = () => settle(false);
        const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);

        pending.set(approvalId, settle);
        request.signal.addEventListener("abort", onAbort, { once: true });

        host.postMessage({
          type: "commandApprovalRequested",
          approvalId,
          command: request.command,
          cwd: request.cwd,
        });
      });
    },
    resolve(approvalId, approved) {
      pending.get(approvalId)?.(approved);
    },
  };
}
