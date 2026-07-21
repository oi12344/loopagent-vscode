# 受控命令执行工具设计

> 状态：已实施，并完成自动化验证与 Windows Extension Host 真实验收。

## 背景

LoopAgent 当前生产 ReAct 路径已经提供 `exploreCode`、`readFile` 和 `applyEdit`。Agent 可以定位代码、
读取文件并提出可审阅的修改，但修改后不能自行运行测试、类型检查或构建，仍需用户在外部终端完成验证。
这使“理解代码 -> 修改代码 -> 验证结果 -> 根据失败继续修复”的最小编码闭环停在最后一步。

本功能增加一个受控的 `runCommand` 工具。它只在用户逐次批准后执行命令，捕获真实输出并返回模型，
不建设通用权限框架、终端系统或任务编排层。

## 目标

1. 允许 Agent 在当前工作区内运行测试、类型检查、构建及其他完成任务所需的非交互命令。
2. 每次执行前完整展示命令和工作目录，由用户明确批准或拒绝。
3. 把退出码、标准输出和标准错误作为 tool observation 返回模型。
4. 限制目录、执行时间和输出大小，并在取消或超时时清理整个命令进程树。
5. 沿用现有 ReAct 工具注册与依赖注入路径，不改变 Webview 消息协议和编辑审阅流程。

## 非目标

- 不保存 `allow / ask / deny` 规则，也不自动批准任何命令。
- 不允许访问工作区外目录。
- 不提供交互式 `stdin`、持续终端会话、PTY、终端面板或命令历史。
- 不流式展示命令输出；第一版只在命令结束后把有界结果返回模型。
- 不自动重试失败命令。
- 不建立命令分类器、白名单语言或通用权限框架。
- 不把跨平台 shell 兼容矩阵作为阶段 A 验收门禁；真实宿主验收以当前 Windows 环境为准。

## 用户可见行为

1. Agent 判断需要验证修改时，调用 `runCommand`，例如 `npm run typecheck`。
2. VS Code 显示模态确认框，包含完整命令和解析后的工作目录。
3. 用户选择执行后，命令在后台运行；选择拒绝后，不创建任何子进程。
4. 命令结束后，模型收到退出码、`stdout` 和 `stderr`，据此继续修复或给出最终结论。
5. 用户点击停止、关闭面板或命令超时时，正在执行的命令及其子进程被终止。

Webview 不增加新控件。现有 Process 区域继续显示通用工具运行事件，最终命令结论由 Agent 回答呈现。

## 方案选择

### 采用：`node:child_process.spawn` 捕获式执行

使用 Node 标准库启动系统 shell，直接捕获 `stdout`、`stderr` 和退出码。该方案能把真实验证结果稳定返回
模型，并且不增加依赖。

### 未采用：VS Code Task API

Task API 适合编辑器任务集成，但捕获任意 shell 任务的完整输出需要额外事件和任务定义桥接，超过当前闭环
所需范围。

### 未采用：VS Code Terminal API

Terminal API 能让用户看到终端，但不能为扩展稳定提供完整的命令输出，不适合作为模型验证工具。

## 工具契约

工具名：`runCommand`

输入：

```ts
{
  command: string;
  cwd?: string;
}
```

- `command` 必须是非空字符串。
- `cwd` 是相对首个 workspace folder 的目录；省略时使用该 workspace folder 根目录。
- 工具不接受超时、输出上限、环境变量或 shell 类型等调用方配置，避免模型绕过固定边界。

结果使用稳定的纯文本结构返回：实际工作目录、退出状态、退出码、`stdout`、`stderr` 和截断说明。
非零退出码表示命令已经正常执行但验证失败，不作为工具基础设施错误抛出。

## 架构与接入点

新增 `src/extension/agent/runCommandTool.ts`，负责输入校验、目录解析、用户审批、进程执行和结果格式化。

生产接入沿用现有工具路径：

```text
LoopAgentChatViewProvider constructor
  -> createRunCommandTool(vscode)
  -> executeRun deps.runCommandTool
  -> createConfiguredAgentRunner
  -> tools: exploreCode + readFile + applyEdit + runCommand
  -> createOpenAiReactModelTurn
```

`src/extension/model/providerRegistry.ts` 的系统提示补充两条约束：修改后按需要使用 `runCommand` 验证；
用户拒绝命令后不得以相同命令重复请求确认。

不新增一层通用 ToolService、PermissionProvider 或 CommandManager。工具由 Chat Provider 创建一次，后续 run
复用，和现有 `readFileTool`、`applyEditTool` 保持一致。

## 目录边界

1. 只使用首个 workspace folder 作为根目录；没有 workspace folder 时工具返回不可用错误。
2. `cwd` 必须是相对路径，绝对路径直接拒绝。
3. 解析根目录和目标目录的真实路径，目标必须存在且为目录。
4. 使用路径分段边界判断目标是否等于根目录或位于根目录下，不能仅用字符串前缀判断。
5. 真实路径检查必须阻止 `..` 和目录符号链接逃逸到工作区外。

目录检查在审批框出现前完成，避免向用户展示一个实际不会执行的请求。

## 审批与执行

审批使用 VS Code 模态消息，完整展示原始命令和解析后的真实工作目录。只有明确选择“执行”才启动进程；
关闭提示框或选择取消都返回 `Command rejected by user`。

审批完成后再次检查 `AbortSignal`。如果 run 在用户作出选择前已被取消，不启动进程。

命令通过 `spawn(command, { cwd, shell: true, windowsHide: true })` 运行，继承 Extension Host 的环境变量，
并关闭 `stdin`。第一版不推断或模拟用户配置的 VS Code 终端 profile；shell 语义由 Node 当前平台默认 shell
决定。

## 资源与失败处理

- 固定超时为 5 分钟，模型不能修改。
- `stdout` 与 `stderr` 合计最多返回 64 KiB；超限时保留尾部并明确标记已截断。
- 非零退出码和命令自身因信号退出均返回结构化命令结果，供模型读取。
- 命令无法启动或目录无效作为工具错误返回。
- 用户拒绝不是工具故障，不触发自动重试。
- `AbortSignal`、超时、Webview 关闭和新 run 替换旧 run 都必须终止整个进程树。
- LoopAgent 主动取消时不再向已经结束的 runner 投递 tool observation；清理失败写入 Extension Host 错误日志。
- 当前 Windows 宿主使用系统进程树终止能力清理 shell 及其子进程；清理操作幂等处理目标已退出竞态，
  但不能吞掉权限错误或其他真实失败。

输出缓冲达到上限后只维护有界尾部，不继续增长内存。进程结束、取消和超时路径都必须移除监听器与定时器。

## 测试与验收

新增一个命令工具测试文件，集中覆盖以下核心边界：

1. 用户批准后在工作区内执行命令，并返回退出码、`stdout` 和 `stderr`。
2. 用户拒绝时不启动进程。
3. 绝对路径、`..` 和符号链接逃逸被拒绝。
4. 非零退出码仍把命令输出返回模型。
5. 超时或取消会终止进程树；大输出被限制并标记截断。

更新现有 provider registry 测试，证明生产模型请求中包含 `runCommand` 的 schema，且现有三个工具仍保留。

集中验证命令：

```powershell
npm test -- runCommandTool
npm test -- providerRegistryCodeContext
npm test
npm run typecheck
npm run compile
git diff --check
```

整体测试点使用唯一的 LoopAgent Extension Development Host，并通过 `npm run debug:vscode` 启动或刷新：

1. 向真实 Agent 提交一个需要运行类型检查的编码任务。
2. 确认审批框完整显示命令与工作目录。
3. 批准执行，确认模型收到真实命令结果并在最终回答中报告验证结论。
4. 再触发一次命令并拒绝，确认没有进程启动且 Agent 尊重拒绝结果。

## 涉及文件

- 新增：`src/extension/agent/runCommandTool.ts`
- 修改：`src/extension/model/providerRegistry.ts`
- 修改：`src/extension.ts`
- 新增：`test/runCommandTool.test.ts`
- 修改：`test/providerRegistryCodeContext.test.ts`
- 新增：`docs/superpowers/plans/2026-07-21-run-command-tool-plan.md`（实施计划阶段）

## 后续边界

只有实际使用证明逐次审批造成明显阻塞后，才评估低风险命令自动批准或持久化权限规则。只有用户明确需要
可交互进程时，才设计 PTY 或 Terminal 集成。只有进入阶段 B 的跨平台要求后，才扩展 shell、信号和进程树
终止的宿主矩阵。

## 实施与验证结果

2026-07-21 已按本设计完成 `runCommand` 工具及生产 ReAct runner 接入：

- `test/runCommandTool.test.ts` 的 5 个用例通过，覆盖批准执行、拒绝、目录逃逸、非零退出、取消/超时与有界输出等核心契约。
- `test/providerRegistryCodeContext.test.ts` 的 3 个用例通过，确认生产模型请求包含 `runCommand`、既有工具仍保留、tool observation 能回传模型。
- 全量测试通过：60 个测试文件、410 个用例；`npm run typecheck`、`npm run compile` 和 `git diff --check` 均通过。
- 使用唯一的 Extension Development Host（`npm run debug:vscode`，固定端口 `9333`）完成真实验收。确认框完整显示命令和 `E:\zz\loopagent-vscode`。
- Run 路径实际执行 `npm run compile`，Agent 报告退出码 `0`、stdout 中的 `node esbuild.js` 和空 stderr。
- Cancel 路径拒绝 `npm run typecheck` 后未执行命令；Agent 明确报告没有真实退出码或输出，且未重复申请同一命令。

实现期间还修复了真实全量测试暴露的两个既有契约问题：恢复 runner 的 `assistantFinished` 事件，并避免旧版会话数据迁移错误激活已清除的现代会话。相关提交见实施计划末尾。
