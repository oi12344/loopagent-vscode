# Agent Runner 适配层设计

## 目标

把当前硬编码的假运行流拆成独立的 runner 边界，让 VS Code Extension Host 只负责接收 Webview 请求、启动一次 run、把 runner 产生的消息回传给 Webview。

## 范围

- 新增 `src/extension/agentRunner.ts`，定义 `AgentRunner`、`AgentRunRequest`、`AgentRunHandle` 和 `startAgentRun`。
- 保留 `src/extension/fakeRun.ts` 的假事件能力，并导出一个 `fakeAgentRunner` 作为当前开发 runner。
- 修改 `src/extension.ts`，让 `loopagent.openPanel` 使用 runner 适配层，而不是直接调用 `createFakeRunMessages`。
- 不接入真实 LLM、工具执行、任务持久化或会话恢复。

## 运行生命周期

1. Webview 发送 `{ type: "startTask", task }`。
2. Extension Host 生成 `runId`，创建 `AbortController`。
3. `AgentRunner.run({ runId, task, signal })` 返回异步消息流。
4. Host 逐条 `postMessage` 给 Webview。
5. runner 抛错时，Host 追加 `{ type: "runFailed", runId, message }`。
6. 返回的 `AgentRunHandle` 暴露 `runId`、`cancel()` 和 `done`，为后续取消按钮与真实 runtime 清理预留边界。

## 取舍

- 采用 `AsyncIterable<HostToWebviewMessage>`，因为真实 agent runtime 后续更可能产生流式事件。
- `fakeAgentRunner` 继续复用已有 `createFakeRunMessages`，避免重复维护假事件内容。
- 第一版只提供取消接口和 `AbortSignal` 传递，不新增 Webview 取消按钮，避免 UI 改动扩大范围。

## 验证方式

- `test/agentRunner.test.ts` 验证消息流回传、异常转 `runFailed`、取消信号。
- 现有 `test/fakeRun.test.ts` 验证 fake 消息内容不回退。
- 执行 `npm test -- --run`、`npm run typecheck`、`npm run compile`。
