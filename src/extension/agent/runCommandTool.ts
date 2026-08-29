import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type * as vscode from "vscode";

import type { ReactAgentTool } from "./reactTypes";
import { SmartCommandExecutor, type CommandResult } from "./smartCommandExecutor";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

const UNSAFE_RECOVERY_COMMAND = /(?:\b(?:git\s+(?:stash|reset|clean|checkout)|rm\s|del\s|rmdir\s|remove-item|chmod|chown|sudo)\b|--force\b|--legacy-peer-deps\b|dependency:purge-local-repository|\/tmp\/|(?:^|\s)(?:tail|head)\b)/i;

export type RunCommandApprovalRequest = {
  command: string;
  cwd: string;
  signal: AbortSignal;
};

export type RunCommandApprover = (request: RunCommandApprovalRequest) => Promise<boolean>;

export type RunCommandToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 审批来源；默认回退到原生 showWarningMessage 模态框 */
  approve?: RunCommandApprover;
  /** 是否启用自动恢复（默认 true） */
  enableAutoRecovery?: boolean;
  /** VSCode 输出通道（用于自动恢复日志） */
  outputChannel?: vscode.OutputChannel;
  /** 测试或宿主可提供共享的智能执行器。 */
  executor?: Pick<SmartCommandExecutor, "executeWithAutoRecovery">;
};

type RecoveryMetadata = {
  attempted: boolean;
  command: string;
  approved: boolean;
  success?: boolean;
};

type RunCommandInput = {
  command: string;
  cwd?: string;
  background?: boolean;
};

type CommandStatus = "exited" | "timed_out";
type OutputKind = "stdout" | "stderr";

type ProgressCheckVerdict = "progressing" | "stalled" | "extending";

type ProgressCheck = {
  /** 从命令启动到本次检查的时间(毫秒) */
  elapsedMs: number;
  /** 累计接收字节数 */
  totalBytes: number;
  /** 本次检查相比上次的字节增长 */
  bytesGrowth: number;
  /** 判定结果 */
  verdict: ProgressCheckVerdict;
  /** 连续沉默次数(仅 stalled 时有值) */
  consecutiveSilentChecks?: number;
};

type ProgressTimeoutOptions = {
  /** 检查间隔(毫秒),默认 30s */
  checkIntervalMs: number;
  /** 容忍连续沉默的检查次数,默认 3 */
  silentChecksLimit: number;
  /** 绝对超时上限(毫秒),不管有无输出都不能越过,默认 10 分钟 */
  maxTimeoutMs: number;
};

export function createRunCommandTool(
  vscodeApi: Pick<typeof vscode, "workspace" | "window">,
  options: RunCommandToolOptions = {},
): ReactAgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const approve = options.approve ?? createNativeApprover(vscodeApi);
  const enableAutoRecovery = options.enableAutoRecovery ?? true;

  // 创建智能执行器（单例）
  const smartExecutor = enableAutoRecovery
    ? (options.executor ?? new SmartCommandExecutor(options.outputChannel))
    : null;

  return {
    name: "runCommand",
    description: enableAutoRecovery
      ? `执行 shell 命令（带自动错误恢复）。

**自动恢复能力**：
当命令失败时，工具会自动分析错误并提供可执行的备选方案：
- 命令不存在 → 切换到备选命令（mvn → mvnw → gradle）
- 依赖问题 → 跳过测试、清理缓存等
- 超时 → 增加超时时间或后台执行
- 权限不足 → 修改权限或使用当前用户
- 输出过大 → 重定向到文件

**后台执行模式（background: true）**：
用于启动长期运行的服务（如 Web 服务器、数据库）：
- 进程立即分离，不会因超时被终止
- 立即返回 PID 和日志文件路径
- 适用场景：启动开发服务器、后台任务、守护进程

**重要**：工具返回结构化结果（JSON 格式），包含：
- success: 是否成功
- stdout/stderr: 输出内容
- error.type: 错误类型
- error.alternatives: 备选方案列表（按成功率排序）

**恢复边界**：
失败后最多自动尝试一个低风险命令型备选方案。备选命令会使用当前工作目录，并遵从本次命令权限；中高风险、跳过操作、工具操作和不兼容命令只作为建议返回。`
      : "Run a non-interactive command inside the current workspace after explicit user approval.",
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description: "Shell 命令字符串"
        },
        cwd: {
          type: "string",
          minLength: 1,
          description: "工作目录（相对于工作区根目录的路径，如 '.' 或 'subdir/module'）。不支持绝对路径。"
        },
        background: {
          type: "boolean",
          description: "后台执行模式。设为 true 时进程立即分离，适用于启动服务器等长期运行的进程。"
        }
      },
      required: ["command"],
      additionalProperties: false,
    },
    async invoke({ input, signal }) {
      const request = parseRunCommandInput(input);
      signal.throwIfAborted();
      const cwd = await resolveWorkspaceCwd(vscodeApi, request.cwd);
      const approved = await approve({ command: request.command, cwd, signal });
      if (!approved) {
        return "Command rejected by user";
      }
      signal.throwIfAborted();

      // 后台执行模式
      if (request.background === true) {
        return executeCommandBackground(request.command, cwd, signal);
      }

      // 使用自动恢复执行
      if (smartExecutor) {
        const initialResult = await smartExecutor.executeWithAutoRecovery(
          request.command,
          cwd,
          {
            timeout: timeoutMs,
            maxAttempts: 1,
            allowAlternatives: true,
            maxBuffer: maxOutputBytes,
          }
        );
        const recoveryCommand = selectRecoveryCommand(initialResult, request.command, cwd);
        if (!recoveryCommand) {
          return formatCommandResultForAgent(initialResult);
        }

        const recoveryApproved = await approve({ command: recoveryCommand, cwd, signal });
        if (!recoveryApproved) {
          return formatCommandResultForAgent(initialResult, {
            attempted: true,
            command: recoveryCommand,
            approved: false,
          });
        }

        const recoveredResult = await smartExecutor.executeWithAutoRecovery(
          recoveryCommand,
          cwd,
          {
            timeout: timeoutMs,
            maxAttempts: 1,
            allowAlternatives: false,
            maxBuffer: maxOutputBytes,
          },
        );
        return formatCommandResultForAgent(recoveredResult, {
          attempted: true,
          command: recoveryCommand,
          approved: true,
          success: recoveredResult.success,
        });
      } else {
        // 降级到原有实现
        return executeCommand(request.command, cwd, signal, timeoutMs, maxOutputBytes);
      }
    },
  };
}

function createNativeApprover(vscodeApi: Pick<typeof vscode, "window">): RunCommandApprover {
  return async ({ command, cwd }) => {
    const approved = await vscodeApi.window.showWarningMessage(
      "LoopAgent wants to run a command.",
      { modal: true, detail: `Command:\n${command}\n\nWorking directory:\n${cwd}` },
      "Run",
    );
    return approved === "Run";
  };
}

function selectRecoveryCommand(result: CommandResult, originalCommand: string, cwd: string): string | undefined {
  const alternative = result.error?.alternatives?.find((candidate) => {
    if (candidate.automation !== "auto" || candidate.risk !== "low" || candidate.action.type !== "command") {
      return false;
    }
    const payload = candidate.action.payload as { command?: unknown; cwd?: unknown };
    return typeof payload.command === "string"
      && payload.command.trim().length > 0
      && (payload.cwd === undefined || payload.cwd === cwd)
      && isSafeRecoveryCommand(payload.command, originalCommand);
  });
  return alternative?.action.payload.command as string | undefined;
}

function isSafeRecoveryCommand(command: string, originalCommand: string): boolean {
  return command.trim() !== originalCommand.trim()
    && !/[\r\n\0]/.test(command)
    && !UNSAFE_RECOVERY_COMMAND.test(command)
    && !(process.platform === "win32" && /(?:^|\s)(?:tail|head)\b|\/tmp\//i.test(command));
}

function parseRunCommandInput(input: unknown): RunCommandInput {
  if (!isRecord(input) || typeof input.command !== "string" || input.command.trim().length === 0) {
    throw new Error("Invalid runCommand input");
  }
  if (!Object.keys(input).every((key) => key === "command" || key === "cwd" || key === "background")) {
    throw new Error("Invalid runCommand input");
  }
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim().length === 0)) {
    throw new Error("Invalid runCommand input");
  }
  if (input.background !== undefined && typeof input.background !== "boolean") {
    throw new Error("Invalid runCommand input");
  }
  const result: RunCommandInput = { command: input.command };
  if (input.cwd !== undefined) result.cwd = input.cwd;
  if (input.background !== undefined) result.background = input.background;
  return result;
}

async function resolveWorkspaceCwd(
  vscodeApi: Pick<typeof vscode, "workspace">,
  requestedCwd: string | undefined,
): Promise<string> {
  const workspaceRoot = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error("runCommand requires an open workspace folder");
  }
  if (requestedCwd !== undefined && isAbsolute(requestedCwd)) {
    throw new Error("Invalid runCommand cwd");
  }

  try {
    const realRoot = await realpath(workspaceRoot);
    const realCwd = await realpath(resolve(realRoot, requestedCwd ?? "."));
    const relation = relative(realRoot, realCwd);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error("Invalid runCommand cwd");
    }
    if (!(await stat(realCwd)).isDirectory()) {
      throw new Error("Invalid runCommand cwd");
    }
    return realCwd;
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid runCommand cwd") {
      throw error;
    }
    throw new Error("Invalid runCommand cwd", { cause: error });
  }
}

export async function executeCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  // 进度超时配置:检查间隔 30s,容忍 3 次连续沉默(90s),绝对上限 10 分钟
  const progressOpts: ProgressTimeoutOptions = {
    checkIntervalMs: 30_000,
    silentChecksLimit: 3,
    maxTimeoutMs: Math.max(timeoutMs, 600_000), // 至少 10 分钟
  };

  return new Promise((resolveResult, rejectResult) => {
    const output = new BoundedOutput(maxOutputBytes);
    const progressChecks: ProgressCheck[] = [];
    const startTime = Date.now();
    let lastCheckBytes = 0;
    let consecutiveSilentChecks = 0;

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timedOut = false;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (progressTimer !== undefined) {
        clearTimeout(progressTimer);
        progressTimer = undefined;
      }
      signal.removeEventListener("abort", onAbort);
    };
    const settleResolve = (status: CommandStatus, code: number | null, childSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(formatCommandResult(cwd, status, code, childSignal, output, progressChecks));
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(error);
    };
    const terminate = async () => {
      if (child.pid === undefined) return;
      try {
        await terminateProcessTree(child.pid);
      } catch (error) {
        console.error("[runCommand] Failed to terminate process tree", error);
      }
    };
    const onAbort = () => {
      void terminate().finally(() => settleReject(abortReason(signal)));
    };

    // 自我重排的进度检查
    const scheduleProgressCheck = (): void => {
      progressTimer = setTimeout(() => {
        if (settled || signal.aborted) return;

        const elapsedMs = Date.now() - startTime;
        const totalBytes = output.totalBytesReceived;
        const bytesGrowth = totalBytes - lastCheckBytes;

        // 判定:有输出 → progressing,无输出 → stalled
        let verdict: ProgressCheckVerdict;
        if (bytesGrowth > 0) {
          verdict = "progressing";
          consecutiveSilentChecks = 0;
        } else {
          verdict = "stalled";
          consecutiveSilentChecks++;
        }

        // 记录本次检查
        const check: ProgressCheck = {
          elapsedMs,
          totalBytes,
          bytesGrowth,
          verdict,
          ...(verdict === "stalled" ? { consecutiveSilentChecks } : {}),
        };
        progressChecks.push(check);
        lastCheckBytes = totalBytes;

        // 超过绝对上限 → 强制终止
        if (elapsedMs >= progressOpts.maxTimeoutMs) {
          timedOut = true;
          void terminate().finally(() => settleResolve("timed_out", null, null));
          return;
        }

        // 连续沉默超限 → 终止
        if (consecutiveSilentChecks >= progressOpts.silentChecksLimit) {
          timedOut = true;
          void terminate().finally(() => settleResolve("timed_out", null, null));
          return;
        }

        // 继续观察
        scheduleProgressCheck();
      }, progressOpts.checkIntervalMs);
    };

    scheduleProgressCheck();

    child.stdout.on("data", (chunk: Buffer) => output.push("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push("stderr", chunk));
    child.once("error", settleReject);
    child.once("close", (code, childSignal) => {
      if (signal.aborted) {
        settleReject(abortReason(signal));
        return;
      }
      settleResolve(timedOut ? "timed_out" : "exited", code, childSignal);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }

  await new Promise<void>((resolveKill, rejectKill) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    killer.stderr.on("data", (chunk: Buffer) => {
      errorText += chunk.toString("utf8");
    });
    killer.once("error", rejectKill);
    killer.once("close", (code) => {
      if (code === 0 || !isProcessAlive(pid)) {
        resolveKill();
        return;
      }
      rejectKill(new Error(errorText.trim() || `taskkill exited with code ${code}`));
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function formatCommandResult(
  cwd: string,
  status: CommandStatus,
  code: number | null,
  signal: NodeJS.Signals | null,
  output: BoundedOutput,
  progressChecks: ProgressCheck[],
): string {
  const lines = [
    `Working directory: ${cwd}`,
    `Status: ${status}`,
    `Exit code: ${code ?? "none"}`,
    `Signal: ${signal ?? "none"}`,
    "stdout:",
    output.render("stdout"),
    "stderr:",
    output.render("stderr"),
  ];

  if (output.truncated) {
    lines.push(`Output truncated to the last ${output.limit} bytes.`);
  }

  // 附加进度检查历史
  if (progressChecks.length > 0) {
    lines.push("", "Progress checks:");
    for (const check of progressChecks) {
      const silentInfo = check.consecutiveSilentChecks !== undefined
        ? ` (silent: ${check.consecutiveSilentChecks})`
        : "";
      lines.push(
        `  ${(check.elapsedMs / 1000).toFixed(1)}s: ${check.verdict}, ` +
        `${check.totalBytes} bytes total (+${check.bytesGrowth})${silentInfo}`
      );
    }
  }

  return lines.join("\n");
}

class BoundedOutput {
  readonly limit: number;
  truncated = false;
  private readonly chunks: Array<{ kind: OutputKind; value: Buffer }> = [];
  private byteLength = 0;
  /** 单调递增的总接收字节数,不受缓冲区限制影响 */
  private _totalBytesReceived = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** 获取累计接收的总字节数(用于进度判定) */
  get totalBytesReceived(): number {
    return this._totalBytesReceived;
  }

  push(kind: OutputKind, chunk: Buffer): void {
    if (chunk.length === 0) return;
    this._totalBytesReceived += chunk.length;
    this.chunks.push({ kind, value: Buffer.from(chunk) });
    this.byteLength += chunk.length;
    while (this.byteLength > this.limit && this.chunks.length > 0) {
      const overflow = this.byteLength - this.limit;
      const first = this.chunks[0]!;
      if (first.value.length <= overflow) {
        this.byteLength -= first.value.length;
        this.chunks.shift();
      } else {
        first.value = first.value.subarray(overflow);
        this.byteLength -= overflow;
      }
      this.truncated = true;
    }
  }

  render(kind: OutputKind): string {
    return Buffer.concat(this.chunks.filter((chunk) => chunk.kind === kind).map((chunk) => chunk.value)).toString("utf8");
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 格式化命令结果为 Agent 可读的 JSON
 */
function formatCommandResultForAgent(result: CommandResult, recovery?: RecoveryMetadata): string {
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

  if (recovery) {
    formatted.recovery = recovery;
  }

  return JSON.stringify(formatted, null, 2);
}

/**
 * 后台执行命令（立即返回 PID，进程分离）
 */
async function executeCommandBackground(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();

  // 生成日志文件路径
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = resolve(cwd, `background-${timestamp}.log`);

  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 关键：分离进程
    });

    const pid = child.pid;
    if (pid === undefined) {
      rejectResult(new Error("Failed to spawn background process"));
      return;
    }

    // 立即解除父进程引用，让子进程独立运行
    child.unref();

    // 写入日志文件（非阻塞，最多等 3 秒）
    const logChunks: Buffer[] = [];
    let logSize = 0;
    const MAX_INITIAL_LOG = 8192; // 最多记录前 8KB

    const logTimeout = setTimeout(() => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      writeLogFileSync();
    }, 3000);

    const writeLogFileSync = () => {
      clearTimeout(logTimeout);
      try {
        const fs = require("node:fs");
        const content = Buffer.concat(logChunks).toString("utf8");
        fs.writeFileSync(logFile, content, "utf8");
      } catch (error) {
        // 日志写入失败不影响进程启动
        console.error("[runCommand] Failed to write background log:", error);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (logSize < MAX_INITIAL_LOG) {
        logChunks.push(chunk);
        logSize += chunk.length;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (logSize < MAX_INITIAL_LOG) {
        logChunks.push(chunk);
        logSize += chunk.length;
      }
    });

    // 立即返回（不等待进程退出）
    const result = [
      `Background process started successfully.`,
      ``,
      `PID: ${pid}`,
      `Working directory: ${cwd}`,
      `Log file: ${logFile}`,
      ``,
      `The process is detached and will continue running independently.`,
      `To stop it:`,
      process.platform === "win32"
        ? `  taskkill /PID ${pid} /F`
        : `  kill ${pid}`,
    ].join("\n");

    resolveResult(result);

    // 监听进程退出（用于清理日志缓冲）
    child.once("exit", () => {
      writeLogFileSync();
    });
  });
}
