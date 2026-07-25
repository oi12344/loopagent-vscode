import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type * as vscode from "vscode";

import type { ReactAgentTool } from "./reactTypes";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

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
};

type RunCommandInput = {
  command: string;
  cwd?: string;
};

type CommandStatus = "exited" | "timed_out";
type OutputKind = "stdout" | "stderr";

export function createRunCommandTool(
  vscodeApi: Pick<typeof vscode, "workspace" | "window">,
  options: RunCommandToolOptions = {},
): ReactAgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const approve = options.approve ?? createNativeApprover(vscodeApi);

  return {
    name: "runCommand",
    description: "Run a non-interactive command inside the current workspace after explicit user approval.",
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
      const approved = await approve({ command: request.command, cwd, signal });
      if (!approved) {
        return "Command rejected by user";
      }
      signal.throwIfAborted();
      return executeCommand(request.command, cwd, signal, timeoutMs, maxOutputBytes);
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

function parseRunCommandInput(input: unknown): RunCommandInput {
  if (!isRecord(input) || typeof input.command !== "string" || input.command.trim().length === 0) {
    throw new Error("Invalid runCommand input");
  }
  if (!Object.keys(input).every((key) => key === "command" || key === "cwd")) {
    throw new Error("Invalid runCommand input");
  }
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim().length === 0)) {
    throw new Error("Invalid runCommand input");
  }
  return input.cwd === undefined ? { command: input.command } : { command: input.command, cwd: input.cwd };
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

function executeCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    const output = new BoundedOutput(maxOutputBytes);
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timedOut = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settleResolve = (status: CommandStatus, code: number | null, childSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(formatCommandResult(cwd, status, code, childSignal, output));
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
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate().finally(() => settleResolve("timed_out", null, null));
    }, timeoutMs);

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
): string {
  return [
    `Working directory: ${cwd}`,
    `Status: ${status}`,
    `Exit code: ${code ?? "none"}`,
    `Signal: ${signal ?? "none"}`,
    "stdout:",
    output.render("stdout"),
    "stderr:",
    output.render("stderr"),
    ...(output.truncated ? [`Output truncated to the last ${output.limit} bytes.`] : []),
  ].join("\n");
}

class BoundedOutput {
  readonly limit: number;
  truncated = false;
  private readonly chunks: Array<{ kind: OutputKind; value: Buffer }> = [];
  private byteLength = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(kind: OutputKind, chunk: Buffer): void {
    if (chunk.length === 0) return;
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
