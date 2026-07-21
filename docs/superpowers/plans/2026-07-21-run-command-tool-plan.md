# 受控命令执行工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为生产 ReAct runner 增加逐次审批、仅限工作区、可取消且能返回真实输出的 `runCommand` 工具。

**Architecture:** 新工具使用 `node:child_process.spawn` 调用平台默认 shell，并在单个模块内完成输入校验、真实路径约束、VS Code 模态审批、有界输出和进程树清理。工具沿用 `LoopAgentChatViewProvider -> createConfiguredAgentRunner -> createOpenAiReactModelTurn` 的现有注入路径，不新增权限或终端抽象层。

**Tech Stack:** TypeScript、VS Code Extension API、Node.js 标准库 `child_process`/`fs`/`path`、Vitest。

## Global Constraints

- 每条命令都必须显示完整命令和真实工作目录，并由用户单独批准。
- 只允许首个 workspace folder 及其真实子目录；绝对路径、`..` 和符号链接逃逸必须拒绝。
- 固定超时 5 分钟；`stdout` 与 `stderr` 合计最多返回 64 KiB 尾部。
- `stdin` 关闭；不新增依赖、PTY、Terminal、Task API、权限记忆、自动批准或自动重试。
- `AbortSignal`、超时、Webview 关闭和新 run 替换旧 run 都必须清理整个进程树。
- 阶段 A 的真实宿主验收仅覆盖当前 Windows 环境，并复用唯一的 Extension Development Host。
- 依据规格：`docs/superpowers/specs/2026-07-21-run-command-tool-design.md`。

---

## 文件结构

- 新增 `src/extension/agent/runCommandTool.ts`：唯一的命令工具实现；包含解析、路径约束、审批、执行、输出格式和进程树终止。
- 新增 `test/runCommandTool.test.ts`：工具契约、信任边界、取消、超时和输出上限。
- 修改 `src/extension/model/providerRegistry.ts`：注入工具并补充生产 system prompt。
- 修改 `src/extension.ts`：在 Chat Provider 生命周期内创建并复用工具。
- 修改 `test/providerRegistryCodeContext.test.ts`：验证真实生产 runner 的工具调用与 observation 回传。
- 更新本计划与对应规格：记录最终命令、真实宿主结果和提交。

### Task 1: 完成受控命令执行工具闭环

**Files:**
- Create: `src/extension/agent/runCommandTool.ts`
- Create: `test/runCommandTool.test.ts`

**Interfaces:**
- Consumes: `ReactAgentTool`；VS Code 的 `workspace.workspaceFolders`、`window.showWarningMessage`；调用方传入的 `AbortSignal`。
- Produces: `createRunCommandTool(vscodeApi, options?): ReactAgentTool`，工具名固定为 `runCommand`，输入为 `{ command: string; cwd?: string }`。

- [x] **Step 1: 写工具契约和安全边界的失败测试**

在 `test/runCommandTool.test.ts` 创建临时根目录与目录型符号链接，fake VS Code API 只实现以下结构：

```ts
const fakeVsCode = {
  workspace: { workspaceFolders: [{ uri: { fsPath: workspaceRoot } }] },
  window: { showWarningMessage: vi.fn(async () => "Run") },
};

const invoke = (input: unknown, signal = new AbortController().signal) =>
  createRunCommandTool(fakeVsCode, { timeoutMs: 100, maxOutputBytes: 1024 }).invoke({
    request: { id: "command-1", name: "runCommand", rawArguments: JSON.stringify(input), input },
    input,
    signal,
  });
```

集中写五个用例，断言必须具体到以下可观察结果：

```ts
it("requires approval and returns cwd, exit code, stdout and stderr", async () => {
  const result = await invoke({ command: nodeCommand("process.stdout.write('ok'); process.stderr.write('warn')") });
  expect(fakeVsCode.window.showWarningMessage).toHaveBeenCalledWith(
    "LoopAgent wants to run a command.",
    expect.objectContaining({ modal: true, detail: expect.stringContaining(workspaceRoot) }),
    "Run",
  );
  expect(result).toContain("Status: exited\nExit code: 0");
  expect(result).toContain("stdout:\nok");
  expect(result).toContain("stderr:\nwarn");
});

it("does not spawn when approval is rejected", async () => {
  fakeVsCode.window.showWarningMessage.mockResolvedValueOnce(undefined);
  await expect(invoke({ command: nodeCommand("process.exit(99)") })).resolves.toBe("Command rejected by user");
});

it.each([{ cwd: "../outside" }, { cwd: outsideRoot }, { cwd: "linked-outside" }])(
  "rejects a cwd outside the real workspace: $cwd",
  async ({ cwd }) => expect(invoke({ command: "echo blocked", cwd })).rejects.toThrow("Invalid runCommand cwd"),
);

it("returns non-zero exits and truncates large output", async () => {
  const result = await invoke({ command: nodeCommand("process.stdout.write('x'.repeat(2048)); process.exit(3)") });
  expect(result).toContain("Exit code: 3");
  expect(result).toContain("Output truncated to the last 1024 bytes.");
});

it("terminates the process tree on timeout and abort", async () => {
  // nodeTreeCommand writes its child PID to pidFile, then parent and child wait.
  await expect(runTimeoutAndAbortCases(nodeTreeCommand(pidFile))).resolves.toEqual(["timed_out", "aborted"]);
  await expect(waitForProcessExit(Number(await readFile(pidFile, "utf8")))).resolves.toBe(true);
});
```

同文件实现 `nodeCommand`、`nodeTreeCommand`、`runTimeoutAndAbortCases` 与 `waitForProcessExit`；它们只组合 `process.execPath`、临时文件和轮询 `process.kill(pid, 0)`，不得用源码字符串断言替代真实子进程。

- [x] **Step 2: 运行测试确认红灯**

Run: `npm test -- runCommandTool`

Expected: FAIL，错误包含 `Cannot find module '../src/extension/agent/runCommandTool'`。

- [x] **Step 3: 实现最小工具**

在 `src/extension/agent/runCommandTool.ts` 实现以下公开形状；`options` 只允许测试缩短超时和输出上限，不暴露给模型：

```ts
export type RunCommandToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export function createRunCommandTool(
  vscodeApi: Pick<typeof vscode, "workspace" | "window">,
  options: RunCommandToolOptions = {},
): ReactAgentTool {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  return {
    name: "runCommand",
    description: "Run a non-interactive command inside the current workspace after explicit user approval.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", minLength: 1 }, cwd: { type: "string", minLength: 1 } },
      required: ["command"],
      additionalProperties: false,
    },
    async invoke({ input, signal }) {
      const request = parseRunCommandInput(input);
      const cwd = await resolveWorkspaceCwd(vscodeApi, request.cwd);
      const approved = await vscodeApi.window.showWarningMessage(
        "LoopAgent wants to run a command.",
        { modal: true, detail: `Command:\n${request.command}\n\nWorking directory:\n${cwd}` },
        "Run",
      );
      if (approved !== "Run") return "Command rejected by user";
      signal.throwIfAborted();
      return executeCommand(request.command, cwd, signal, timeoutMs, maxOutputBytes);
    },
  };
}
```

`parseRunCommandInput` 只接受 `command`/`cwd` 两个键并拒绝空白命令。`resolveWorkspaceCwd` 使用 `realpath`、`stat`、`resolve` 和 `relative`，只有 `relativeRoot === ""` 或不以 `..${sep}` 开头且不是绝对路径时通过。

`executeCommand` 使用 `spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })`。输出缓冲只保留 UTF-8 字节尾部；结果格式固定为：

```text
Working directory: <real cwd>
Status: exited | timed_out
Exit code: <number | none>
Signal: <string | none>
stdout:
<bounded stdout>
stderr:
<bounded stderr>
<optional truncation notice>
```

取消时先清理进程树，再以 `signal.reason` 拒绝；超时时清理后返回 `Status: timed_out`。Windows 调用 `taskkill.exe /PID <pid> /T /F`，非 Windows 对 detached process group 发送信号；目标已退出按幂等成功处理，其他错误写入 `console.error` 后继续释放监听器和定时器。

- [x] **Step 4: 运行核心测试确认绿灯**

Run: `npm test -- runCommandTool`

Expected: PASS，5 个核心用例通过，测试结束后无残留 node 子进程。

- [x] **Step 5: 提交核心工具**

```powershell
git add src/extension/agent/runCommandTool.ts test/runCommandTool.test.ts
git commit -m "feat(agent): add approved workspace command tool"
```

### Task 2: 接入生产 ReAct runner

**Files:**
- Modify: `src/extension/model/providerRegistry.ts:19-92`
- Modify: `src/extension.ts:1-92,233-254`
- Modify: `test/providerRegistryCodeContext.test.ts:125-229`

**Interfaces:**
- Consumes: Task 1 的 `createRunCommandTool` 与 `ReactAgentTool`。
- Produces: `CreateConfiguredAgentRunnerDeps.runCommandTool?: ReactAgentTool`，生产工具顺序为 `exploreCode`、`readFile`、`applyEdit`、`runCommand`。

- [x] **Step 1: 扩展生产 runner 失败测试**

把现有 `returns readFile and confirmed applyEdit observations to the model` 改名为 `returns read, edit and approved command observations to the model`，增加：

```ts
const runCommandTool: ReactAgentTool = {
  name: "runCommand",
  description: "Run an approved command.",
  inputSchema: { type: "object" },
  invoke: vi.fn(async () => "Status: exited\nExit code: 0\nstdout:\ntypecheck passed\nstderr:\n"),
};
```

模型 mock 在 `applyEdit` observation 后再发一轮 `runCommand` tool call，参数为 `{"command":"npm run typecheck"}`，随后才返回 final。创建 runner 时传入 `runCommandTool`，并增加：

```ts
expect(runCommandTool.invoke).toHaveBeenCalledTimes(1);
expect(systemPrompt).toContain("Use runCommand when tests, type checks, or builds are relevant to verify a change.");
expect(systemPrompt).toContain("If the user rejects a command, do not request the same command again.");
expect(capturedMessages.flat()).toContainEqual(expect.objectContaining({
  role: "tool",
  name: "runCommand",
  content: expect.stringContaining("Exit code: 0"),
}));
```

- [x] **Step 2: 运行测试确认红灯**

Run: `npm test -- providerRegistryCodeContext`

Expected: FAIL，`runCommandTool.invoke` 未调用，system prompt 缺少两条命令规则。

- [x] **Step 3: 完成最小生产接入**

在 `CreateConfiguredAgentRunnerDeps` 增加 `runCommandTool?: ReactAgentTool`，并在 tools 数组末尾加入：

```ts
...(deps.runCommandTool ? [deps.runCommandTool] : []),
```

在 `REACT_SYSTEM_PROMPT` 的 `applyEdit` 规则后增加测试所用的两条精确英文规则。

在 `src/extension.ts` 导入 `createRunCommandTool`，增加 `private readonly runCommandTool`，构造函数调用 `createRunCommandTool(vscode)`，并在 `executeRun` 的依赖对象中传入：

```ts
runCommandTool: this.runCommandTool,
```

不修改 `ReactAgentTool`、Webview 消息、`reactAgentRunner` 或并发调度；`runCommand` 未声明 `isConcurrencySafe`，自然保持串行。

- [x] **Step 4: 运行接入测试、类型检查和编译**

Run: `npm test -- providerRegistryCodeContext`

Expected: PASS，原有 explore/read/edit 用例和新增 command observation 均通过。

Run: `npm run typecheck`

Expected: PASS，无 TypeScript 错误。

Run: `npm run compile`

Expected: PASS，`dist/extension.js` 与 `dist/webview.js` 构建成功。

- [x] **Step 5: 提交生产接入**

```powershell
git add src/extension.ts src/extension/model/providerRegistry.ts test/providerRegistryCodeContext.test.ts
git commit -m "feat(agent): wire approved commands into react runner"
```

### Task 3: 集中验证与真实宿主验收

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-run-command-tool-design.md`
- Modify: `docs/superpowers/plans/2026-07-21-run-command-tool-plan.md`

- [x] **Step 1: 运行集中自动验证**

```powershell
npm test -- runCommandTool
npm test -- providerRegistryCodeContext
npm test
npm run typecheck
npm run compile
git diff --check
```

Expected: 所有命令退出码为 0；Vitest 无失败文件/用例；TypeScript 与 esbuild 成功；diff 无空白错误。

- [x] **Step 2: 在唯一调试窗口完成真实闭环**

如果固定调试窗口未运行，执行一次 `npm run debug:vscode`；已运行则刷新同一窗口并重新执行 `LoopAgent: Open Panel`。向真实 Agent 提交“运行 `npm run typecheck` 并报告结果”，确认：

模态框必须完整显示命令与 `E:\zz\loopagent-vscode`；选择 `Run` 后 Agent 收到真实结果并给出结论；关闭第二次无副作用命令的审批框后不创建进程且不重复申请；结束时只有一个调试窗口且无遗留进程。

- [x] **Step 3: 集中审查与清理**

Run: `git diff -- src/extension/agent/runCommandTool.ts src/extension/model/providerRegistry.ts src/extension.ts test/runCommandTool.test.ts test/providerRegistryCodeContext.test.ts`

Expected: 只包含本功能；无临时日志、死代码、新依赖、权限缓存或工作区外访问路径。

- [x] **Step 4: 更新中文实施结果并提交**

在规格状态和本计划末尾写入实际测试文件/用例数、六条验证命令结果、真实审批/拒绝结果、提交号及实际限制；不得预填未执行结果。

```powershell
git add docs/superpowers/specs/2026-07-21-run-command-tool-design.md docs/superpowers/plans/2026-07-21-run-command-tool-plan.md
git commit -m "docs: record approved command verification"
```

## 实施结果

完成日期：2026-07-21。

自动化验证：

- `npm test -- runCommandTool`：通过，1 个测试文件、5 个用例。
- `npm test -- providerRegistryCodeContext`：通过，1 个测试文件、3 个用例。
- `npm test`：通过，60 个测试文件、410 个用例。
- `npm run typecheck`：通过，无 TypeScript 错误。
- `npm run compile`：通过，esbuild 成功生成扩展与 Webview 产物。
- `git diff --check ae6c85d..HEAD`：通过，无空白错误。

真实宿主验收：

- 通过 `npm run debug:vscode` 启动并复用唯一的 LoopAgent Extension Development Host，固定远程调试端口为 `9333`。
- 审批框完整显示 `npm run compile` 与真实工作目录 `E:\zz\loopagent-vscode`；选择 Run 后命令实际执行，Agent 报告退出码 `0`、stdout 为 `npm run compile`/`node esbuild.js`，stderr 为空。
- 另一轮审批中拒绝 `npm run typecheck`；命令未执行，Agent 明确说明没有真实退出码或输出，并且没有再次申请同一命令。
- 验收结束时仅存在一个 Extension Development Host，无额外调试配置目录。

相关提交：

- `ac1e648 feat(agent): add approved workspace command tool`
- `4ef9550 fix(agent): tolerate missing debug output channel`
- `4e490e5 feat(agent): wire approved commands into react runner`
- `8c9407e fix(agent): restore conversation completion events`
- `8a11ea4 fix(conversation): migrate legacy active pointer`

当前阶段保留的边界与设计一致：逐次审批、非交互命令、首个工作区目录、固定 5 分钟超时和 64 KiB 有界输出；未增加权限记忆、PTY、Terminal 或 Task API。
