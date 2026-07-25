import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRunCommandTool } from "../src/extension/agent/runCommandTool";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";

const spawnedPids = new Set<number>();

describe("runCommand tool", () => {
  let temporaryRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  let approve: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "loopagent-command-"));
    workspaceRoot = join(temporaryRoot, "workspace");
    outsideRoot = join(temporaryRoot, "outside");
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
    await symlink(outsideRoot, join(workspaceRoot, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
    approve = vi.fn(async () => "Run");
  });

  afterEach(async () => {
    for (const pid of spawnedPids) forceKill(pid);
    spawnedPids.clear();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("declares itself safe for concurrent execution", () => {
    const tool = createTool(workspaceRoot, approve);
    expect(tool.isConcurrencySafe?.({ command: "echo hi" })).toBe(true);
  });

  it("uses an injected approver instead of the native modal when provided", async () => {
    const injectedApprove = vi.fn(async () => true);
    const tool = createRunCommandTool(
      {
        workspace: { workspaceFolders: [{ uri: { fsPath: workspaceRoot } }] },
        window: { showWarningMessage: approve },
      } as never,
      { timeoutMs: 5_000, approve: injectedApprove },
    );

    const result = await invoke(tool, { command: nodeCommand("process.stdout.write('ok')") });

    expect(injectedApprove).toHaveBeenCalledWith(
      expect.objectContaining({ command: nodeCommand("process.stdout.write('ok')"), cwd: workspaceRoot }),
    );
    expect(approve).not.toHaveBeenCalled();
    expect(result).toContain("stdout:\nok");
  });

  it("rejects the command when the injected approver returns false", async () => {
    const marker = join(workspaceRoot, "should-not-exist.txt");
    const injectedApprove = vi.fn(async () => false);
    const tool = createRunCommandTool(
      {
        workspace: { workspaceFolders: [{ uri: { fsPath: workspaceRoot } }] },
        window: { showWarningMessage: approve },
      } as never,
      { timeoutMs: 5_000, approve: injectedApprove },
    );

    await expect(
      invoke(tool, { command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`) }),
    ).resolves.toBe("Command rejected by user");
    await expect(access(marker)).rejects.toThrow();
  });

  it("requires approval and returns cwd, exit code, stdout and stderr", async () => {
    const tool = createTool(workspaceRoot, approve);
    const result = await invoke(tool, {
      command: nodeCommand("process.stdout.write('ok'); process.stderr.write('warn')"),
    });

    expect(approve).toHaveBeenCalledWith(
      "LoopAgent wants to run a command.",
      expect.objectContaining({ modal: true, detail: expect.stringContaining(workspaceRoot) }),
      "Run",
    );
    expect(result).toContain("Status: exited\nExit code: 0");
    expect(result).toContain("stdout:\nok");
    expect(result).toContain("stderr:\nwarn");
  });

  it("does not spawn when approval is rejected", async () => {
    const marker = join(workspaceRoot, "should-not-exist.txt");
    approve.mockResolvedValueOnce(undefined);

    await expect(
      invoke(createTool(workspaceRoot, approve), {
        command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
      }),
    ).resolves.toBe("Command rejected by user");
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects invalid input and cwd escapes before approval", async () => {
    const tool = createTool(workspaceRoot, approve);

    for (const input of [{}, { command: "   " }, { command: "echo blocked", extra: true }]) {
      await expect(invoke(tool, input)).rejects.toThrow("Invalid runCommand input");
    }
    for (const cwd of ["../outside", outsideRoot, "linked-outside"]) {
      await expect(invoke(tool, { command: "echo blocked", cwd })).rejects.toThrow("Invalid runCommand cwd");
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it("returns non-zero exits and truncates large output", async () => {
    const tool = createTool(workspaceRoot, approve, { maxOutputBytes: 1024 });
    const result = await invoke(tool, {
      command: nodeCommand("process.stdout.write('x'.repeat(2048)); process.exit(3)"),
    });

    expect(result).toContain("Exit code: 3");
    expect(result).toContain("Output truncated to the last 1024 bytes.");
  });

  it("terminates the process tree on timeout and abort", async () => {
    const timeoutPidFile = join(workspaceRoot, "timeout.pid");
    const timeoutPromise = invoke(
      createTool(workspaceRoot, approve, { timeoutMs: 250 }),
      { command: nodeTreeCommand(timeoutPidFile) },
    );
    const timeoutPid = await readPidWhenReady(timeoutPidFile);
    const timeoutResult = await timeoutPromise;
    expect(timeoutResult).toContain("Status: timed_out");
    await expect(waitForProcessExit(timeoutPid)).resolves.toBe(true);

    const abortPidFile = join(workspaceRoot, "abort.pid");
    const controller = new AbortController();
    const abortPromise = invoke(
      createTool(workspaceRoot, approve),
      { command: nodeTreeCommand(abortPidFile) },
      controller.signal,
    );
    const abortPid = await readPidWhenReady(abortPidFile);
    controller.abort();
    await expect(abortPromise).rejects.toThrow(/aborted/i);
    await expect(waitForProcessExit(abortPid)).resolves.toBe(true);
  }, 15_000);
});

function createTool(
  workspaceRoot: string,
  approve: ReturnType<typeof vi.fn>,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): ReactAgentTool {
  return createRunCommandTool(
    {
      workspace: { workspaceFolders: [{ uri: { fsPath: workspaceRoot } }] },
      window: { showWarningMessage: approve },
    } as never,
    { timeoutMs: 5_000, ...options },
  );
}

function invoke(tool: ReactAgentTool, input: unknown, signal = new AbortController().signal): Promise<string> {
  return Promise.resolve(tool.invoke({
    request: { id: "command-1", name: "runCommand", rawArguments: JSON.stringify(input), input },
    input,
    signal,
  }));
}

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script).toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

function nodeTreeCommand(pidFile: string): string {
  return nodeCommand([
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" "));
}

async function readPidWhenReady(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      spawnedPids.add(pid);
      return pid;
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for child pid: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) {
      spawnedPids.delete(pid);
      return true;
    }
    await delay(25);
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function forceKill(pid: number): void {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort test cleanup.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
