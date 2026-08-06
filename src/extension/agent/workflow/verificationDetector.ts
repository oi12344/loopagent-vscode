import type { HostToWebviewMessage } from "../../../shared/messages";

/**
 * 验证命令模式 - 常见的测试、类型检查、构建命令
 */
const VERIFICATION_PATTERNS = [
  // 测试命令
  /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
  /\b(pytest|jest|vitest|mocha|ava|tape)\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmvn\s+test\b/,
  /\bgradle\s+test\b/,

  // 类型检查
  /\btsc\b.*--noEmit/,
  /\b(npm|yarn|pnpm)\s+(run\s+)?typecheck\b/,
  /\bmypy\b/,

  // 构建命令
  /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
  /\bcargo\s+build\b/,
  /\bgo\s+build\b/,
  /\bmvn\s+(clean\s+)?compile\b/,
  /\bgradle\s+build\b/,

  // Lint（部分验证）
  /\b(npm|yarn|pnpm)\s+(run\s+)?lint\b/,
  /\beslint\b/,
  /\bruff\b/,
  /\bcargo\s+clippy\b/,
];

/**
 * 从子代理消息中检测是否运行了验证命令
 */
export function detectVerificationFromMessages(messages: readonly HostToWebviewMessage[]): {
  hasVerification: boolean;
  verificationCommands: string[];
  verificationPassed: boolean;
  failureReason?: string;
} {
  const verificationCommands: string[] = [];
  const commandResults = new Map<string, { command: string; succeeded: boolean }>();
  let hasFailure = false;
  let failureReason: string | undefined;

  for (const message of messages) {
    // 记录验证命令的开始
    if (message.type === "toolCallStarted" && message.toolName === "runCommand") {
      const command = message.input;
      if (command && VERIFICATION_PATTERNS.some(pattern => pattern.test(command))) {
        verificationCommands.push(command);
        commandResults.set(message.callId, { command, succeeded: true });
      }
    }

    // 检查验证命令的结果
    if (message.type === "toolCallFinished") {
      const commandInfo = commandResults.get(message.callId);
      if (commandInfo) {
        commandResults.set(message.callId, { ...commandInfo, succeeded: message.succeeded });
        if (!message.succeeded) {
          hasFailure = true;
          failureReason = `Verification command failed: ${commandInfo.command}`;
        }
      }
    }

    // 检查错误消息
    if (message.type === "agentEvent" && message.message.includes("failed")) {
      const msg = message.message.toLowerCase();
      if (msg.includes("test") || msg.includes("build") || msg.includes("typecheck")) {
        hasFailure = true;
        if (!failureReason) failureReason = message.message;
      }
    }
  }

  return {
    hasVerification: verificationCommands.length > 0,
    verificationCommands,
    verificationPassed: verificationCommands.length > 0 && !hasFailure,
    failureReason,
  };
}

/**
 * 判断验证状态
 */
export function determineVerificationStatus(
  role: string,
  messages: readonly HostToWebviewMessage[],
  status: "completed" | "failed" | "cancelled",
): {
  verificationStatus: "passed" | "failed" | "skipped" | "not-run";
  verificationDetails?: string;
} {
  // 只有 executor 角色需要验证
  if (role !== "executor") {
    return { verificationStatus: "skipped", verificationDetails: "Non-executor role, verification not required" };
  }

  // 如果任务本身失败或取消，不检查验证
  if (status === "failed" || status === "cancelled") {
    return { verificationStatus: "skipped", verificationDetails: "Task did not complete successfully" };
  }

  const detection = detectVerificationFromMessages(messages);

  if (!detection.hasVerification) {
    return {
      verificationStatus: "not-run",
      verificationDetails: "No verification commands detected. Expected test, typecheck, or build commands.",
    };
  }

  if (detection.verificationPassed) {
    return {
      verificationStatus: "passed",
      verificationDetails: `Ran: ${detection.verificationCommands.join(", ")}`,
    };
  }

  return {
    verificationStatus: "failed",
    verificationDetails: detection.failureReason || "Verification command failed",
  };
}
