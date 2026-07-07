# 类 Copilot 对话 UI 实施计划

SUB-SKILL: task-by-task

## Goal

把 LoopAgent Webview 从事件列表升级为真实对话 UI，并通过 DeepSeek v4 flash 真实返回验证消息展示。

## Architecture

`src/shared/messages.ts` 定义 Webview 协议；`src/extension/model/modelRunner.ts` 将 provider 流式事件转换为 UI 事件；`src/webview/App.tsx` 维护对话状态；`src/webview/styles.css` 负责 VS Code 风格布局。provider 层继续保持 OpenAI-compatible 抽象，不把 UI 状态塞回模型客户端。

## Tech Stack

TypeScript、React、VS Code Webview、Vitest、Testing Library、esbuild、VS Code Extension Development Host。

## Task 1: 文档与范围确认

Create: `docs/superpowers/specs/2026-07-06-copilot-style-chat-ui-design.md`
Create: `docs/superpowers/plans/2026-07-06-copilot-style-chat-ui-plan.md`

记录目标、范围、协议、UI 行为、禁止展示原始思维链、禁止持久化真实 API key，以及验证命令。

## Task 2: Runner RED 测试

Modify: `test/modelProvider.test.ts`

新增行为测试：

```ts
expect(hostMessages).toEqual([
  { type: "runStarted", runId: "run-1", task: "Inspect workspace" },
  { type: "assistantStarted", runId: "run-1", provider: "Test Model" },
  { type: "assistantThinking", runId: "run-1", message: "Calling Test Model" },
  { type: "assistantThinking", runId: "run-1", message: "Received model reasoning signal" },
  { type: "assistantDelta", runId: "run-1", content: "The " },
  { type: "assistantDelta", runId: "run-1", content: "workspace is ready." },
  { type: "assistantFinished", runId: "run-1" },
  { type: "runFinished", runId: "run-1" },
]);
```

Run: `npm test -- --run test/modelProvider.test.ts`

Expected: fails because the protocol and runner do not emit these messages yet.

## Task 3: Webview RED 测试

Modify: `test/App.test.tsx`

新增行为测试：

- 初始界面显示 `LoopAgent`、`Message` 输入框、`Send` 按钮和空对话占位。
- 发送 `hello` 后展示用户消息并发送 `startTask`。
- 收到 `assistantStarted`、`assistantThinking`、`assistantDelta`、`assistantFinished` 后展示 provider、过程区和最终回答。
- 收到 `runFailed` 后在助手区域展示错误并恢复发送按钮。
- 旧 `agentEvent` 仍能进入过程区。

Run: `npm test -- --run test/App.test.tsx`

Expected: fails because当前 Webview 仍是事件列表。

## Task 4: 实现协议与 runner

Modify: `src/shared/messages.ts`
Modify: `src/extension/model/modelRunner.ts`

- 增加 `assistantStarted`、`assistantThinking`、`assistantDelta`、`assistantFinished` 类型。
- runner 开始后发送 `assistantStarted`。
- 调用 provider 前发送 `assistantThinking: Calling <provider>`。
- 首次收到 `reasoningDelta` 时发送一次 `assistantThinking: Received model reasoning signal`。
- 每个 `contentDelta` 直接发送 `assistantDelta`。
- provider 正常结束后发送 `assistantFinished` 和 `runFinished`。

Run: `npm test -- --run test/modelProvider.test.ts`

Expected: pass。

## Task 5: 实现 Webview 对话 UI

Modify: `src/webview/App.tsx`
Modify: `src/webview/styles.css`

- 用 `turns` 状态保存用户和助手消息。
- 输入区改为底部 composer，按钮文案为 `Send` / `Sending...`。
- 助手消息渲染 provider、status、过程区和 answer。
- 兼容旧 `agentEvent`：存在当前 assistant turn 时加入过程区；不存在时创建 legacy assistant turn。
- 错误状态在当前 assistant turn 上展示。

Run: `npm test -- --run test/App.test.tsx`

Expected: pass。

## Task 6: 全量验证与清理

Run:

```powershell
npm test -- --run
npm run typecheck
npm run compile
rg "sk-[0-9a-fA-F]{8,}|3b11df63|console\\.log|debugger|\\.tmp-vscode|TODO|TBD" -g "!node_modules/**" -g "!dist/**"
```

Expected: tests、typecheck、compile 通过；扫描不发现真实 key、调试日志或未处理占位。

## Task 7: 真实 VS Code E2E

Run: `npm run debug:vscode`

在唯一 Extension Development Host 中：

1. 配置 `loopagent.model.provider` 为 `deepseek`。
2. 以 SecretStorage 或临时进程环境提供真实 DeepSeek API key，不写入仓库。
3. 执行 `LoopAgent: Open Panel`。
4. 输入 `hello` 并发送。
5. 验证 UI 显示用户消息、过程区、DeepSeek provider 名称和模型返回内容。

完成后更新本文档验证记录，清理临时截图和临时配置。

## 验证记录

2026-07-06 已完成：

- RED：`npm test -- --run test/modelProvider.test.ts` 先失败，原因为 runner 仍输出旧 `agentEvent` 序列。
- RED：`npm test -- --run test/App.test.tsx` 先失败，原因为 Webview 仍是旧任务 composer 和事件列表。
- GREEN：`npm test -- --run test/modelProvider.test.ts` 通过，2 个测试通过。
- GREEN：`npm test -- --run test/App.test.tsx` 通过，5 个测试通过。
- 全量：`npm test -- --run` 通过，7 个测试文件、20 个测试通过。
- 类型检查：`npm run typecheck` 通过。
- 构建：`npm run compile` 通过。
- 扫描：执行敏感 key、调试语句、临时文件和占位标记扫描，未发现匹配；文档不记录真实 key 片段。
- 真实 VS Code E2E：使用 `npm run debug:vscode` 启动唯一 Extension Development Host，通过临时进程环境变量提供真实 DeepSeek key，通过调试用户目录临时配置 `loopagent.model.provider=deepseek`、`loopagent.model.model=deepseek-v4-flash`、`loopagent.model.thinking=enabled`。
- 真实消息：在 Webview 输入 `hello` 并发送，UI 展示用户消息、`DeepSeek deepseek-v4-flash`、`Process`、`Calling DeepSeek deepseek-v4-flash`、`Received model reasoning signal` 和真实模型回答。
- 清理：已删除临时 `.local-vscode-user-data/User/settings.json`、`.tmp-vscode-open-panel.png`、`.tmp-vscode-hello-result.png`。
