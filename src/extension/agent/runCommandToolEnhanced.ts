/**
 * 增强的 runCommand 工具 - 集成自动错误恢复
 *
 * 替换原有的 runCommandTool.ts，添加自动恢复能力
 */

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type * as vscode from "vscode";

import type { ReactAgentTool } from "./reactTypes";
import { SmartCommandExecutor, CommandResult } from "./smartCommandExecutor";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

// 安全命令白名单
const SAFE_COMMAND_PATTERNS = [
  /^git\s+/i,
  /^npm\s+(install|ci|test)/i,
  /^mvn\s+/i,
  /^\.\/mvnw/i,
  /^gradle/i,
  /^findstr\s+/i,
  /^grep\s+/i,
  /^ls\s+/i,
  /^dir\s+/i,
  /^cat\s+/i,
  /^type\s+/i,
];

export type RunCommandApprovalRequest = {
  command: string;
  cwd: string;
  signal: AbortSignal;
};

export type RunCommandApprover = (request: RunCommandApprovalRequest) => Promise<boolean>;

export type RunCommandToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  approve?: RunCommandApprover;
  /** 是否启用自动恢复（默认 true） */
  enableAutoRecovery?: boolean;
};

type RunCommandInput = {
  command: string;
  cwd?: string;
};

/**
 * 创建增强的 runCommand 工具
 */
export function createRunCommandTool(
  vscodeApi: Pick<typeof vscode, "workspace" | "window">,
  options: RunCommandToolOptions = {},
): ReactAgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const approve = options.approve ?? createNativeApprover(vscodeApi);
  const enableAutoRecovery = options.enableAutoRecovery ?? true;

  // 创建智能执行器（单例）
  const outputChannel = vscodeApi.window.createOutputChannel?.('LoopAgent - Command Execution');
  const smartExecutor = new SmartCommandExecutor(outputChannel);

  return {
    name: "runCommand",
    description: `执行 shell 命令（带自动错误恢复）。

**自动恢复能力**：
当命令失败时，工具会自动分析错误并提供可执行的备选方案：
- 命令不存在 → 切换到备选命令（mvn → mvnw → gradle）
- 依赖问题 → 跳过测试、清理缓存等
- 超时 → 增加超时时间或后台执行
- 权限不足 → 修改权限或使用当前用户
- 输出过大 → 重定向到文件

**重要**：工具返回结构化结果，包含：
- success: 是否成功
- stdout/stderr: 输出内容
- error.type: 错误类型
- error.alternatives: 备选方案列表（按成功率排序）

**处理失败的正确方式**：
1. 读取 error.alternatives 数组
2. 选择第一个 automation='auto' 且 successProbability>0.7 的方案
3. 直接执行该方案（无需询问用户）
4. 如果仍失败，尝试下一个备选方案

**禁止行为**：
- ❌ 对同一命令重试超过 3 次
- ❌ 在每次切换方案时都询问用户
- ❌ 忽略 alternatives 字段，自己瞎猜解决方案`,

    isConcurrencySafe: () => true,

    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
      },
      required: ["command"],
      additionalProperties: false,
    },

    async invoke({ input, signal }) {
      const request = parseRunCommandInput(input);
      signal.throwIfAborted();

      const cwd = await resolveWorkspaceCwd(vscodeApi, request.cwd);

      // 审批检查
      const approved = await approve({ command: request.command, cwd, signal });
      if (!approved) {
        return "Command rejected by user";
      }

      signal.throwIfAborted();

      // 使用自动恢复执行
      if (enableAutoRecovery) {
        const result = await smartExecutor.executeWithAutoRecovery(
          request.command,
          cwd,
          {
            timeout: timeoutMs,
            maxAttempts: 3,
            allowAlternatives: true,
            maxBuffer: maxOutputBytes,
          }
        );

        return formatCommandResultForAgent(result);
      } else {
        // 降级到原有实现
        return executeCommandLegacy(request.command, cwd, signal, timeoutMs, maxOutputBytes);
      }
    },
  };
}

/**
 * 格式化结果为 Agent 可读的 JSON
 */
function formatCommandResultForAgent(result: CommandResult): string {
  const formatted: any = {
    success: result.success,
  };

  if (result.success) {
    // 成功：返回输出
    formatted.stdout = result.stdout || '';
    formatted.stderr = result.stderr || '';
    formatted.exitCode = result.exitCode || 0;

    if (result.context) {
      formatted.context = {
        command: result.context.command,
        duration: `${result.context.duration}ms`,
      };
    }
  } else {
    // 失败：返回错误和备选方案
    formatted.error = {
      type: result.error?.type,
      message: result.error?.message,
    };

    if (result.stderr) {
      formatted.stderr = result.stderr;
    }

    if (result.stdout) {
      formatted.stdout = result.stdout;
    }

    // 🔑 关键：包含备选方案
    if (result.error?.alternatives && result.error.alternatives.length > 0) {
      formatted.alternatives = result.error.alternatives.map(alt => ({
        description: alt.description,
        automation: alt.automation,
        successProbability: alt.successProbability,
        risk: alt.risk,
        action: alt.action,
      }));

      // 添加提示
      formatted.hint = '⚡ 发现可自动执行的备选方案。建议直接尝试第一个方案（成功率最高）。';
    }
  }

  return JSON.stringify(formatted, null, 2);
}

/**
 * 原有的命令执行逻辑（作为降级方案）
 */
async function executeCommandLegacy(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  // 原有实现保持不变
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutputBytes) {
        proc.kill();
      }
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxOutputBytes) {
        proc.kill();
      }
    });

    proc.on('exit', (code, sig) => {
      clearTimeout(timeout);

      const status = timedOut ? 'timed_out' : 'exited';
      const result = [
        `Working directory: ${cwd}`,
        `Status: ${status}`,
        `Exit code: ${code ?? 'none'}`,
        `Signal: ${sig ?? 'none'}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join('\n');

      resolvePromise(result);
    });

    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      proc.kill();
      rejectPromise(new Error('Command aborted'));
    });
  });
}

function createNativeApprover(vscodeApi: Pick<typeof vscode, "window">): RunCommandApprover {
  return async ({ command, cwd }) => {
    if (isSafeCommand(command)) {
      return true;
    }

    const approved = await vscodeApi.window.showWarningMessage(
      "LoopAgent wants to run a command.",
      { modal: true, detail: `Command:\n${command}\n\nWorking directory:\n${cwd}` },
      "Run",
    );
    return approved === "Run";
  };
}

function isSafeCommand(command: string): boolean {
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function parseRunCommandInput(input: unknown): RunCommandInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid runCommand input: must be an object");
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.command !== "string" || !obj.command.trim()) {
    throw new Error("Invalid runCommand input: command must be a non-empty string");
  }

  const result: RunCommandInput = { command: obj.command };

  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") {
      throw new Error("Invalid runCommand input: cwd must be a string");
    }
    result.cwd = obj.cwd;
  }

  return result;
}

async function resolveWorkspaceCwd(
  vscodeApi: Pick<typeof vscode, "workspace">,
  requestedCwd?: string,
): Promise<string> {
  const workspaceFolders = vscodeApi.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder open");
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  if (!requestedCwd) {
    return workspaceRoot;
  }

  const resolvedCwd = isAbsolute(requestedCwd)
    ? requestedCwd
    : resolve(workspaceRoot, requestedCwd);

  const realCwd = await realpath(resolvedCwd);
  const realWorkspaceRoot = await realpath(workspaceRoot);

  if (!realCwd.startsWith(realWorkspaceRoot + sep) && realCwd !== realWorkspaceRoot) {
    throw new Error(`Invalid runCommand cwd: ${requestedCwd} is outside workspace`);
  }

  const cwdStat = await stat(realCwd).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    throw new Error(`Invalid runCommand cwd: ${requestedCwd} is not a directory`);
  }

  return realCwd;
}
