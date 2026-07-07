# Webview 消息协议实施计划

## 背景

当前 React Webview 只能展示静态界面。为了进入代码智能体 runtime 开发，需要先打通 Webview 与 Extension Host 的消息链路。

本计划只实现消息桥和假事件流，不接入模型或真实工具执行。

## 实施步骤

### 1. 文档落地

新增本计划和对应设计文档：

- `docs/superpowers/specs/2026-07-05-webview-message-protocol-design.md`
- `docs/superpowers/plans/2026-07-05-webview-message-protocol-plan.md`

### 2. 失败测试

先扩展 `test/App.test.tsx`，验证当前 UI 缺少消息能力：

- 点击 `Run` 应发送 `startTask`。
- 空输入不能发送消息。
- 收到 `runStarted`、`agentEvent`、`runFinished` 后应更新事件列表和按钮状态。

预期 RED 阶段失败，因为当前 `App.tsx` 没有消息发送和接收逻辑。

### 3. 共享消息类型

新增：

- `src/shared/messages.ts`

定义 `WebviewToHostMessage` 和 `HostToWebviewMessage`。

### 4. Webview API 包装

新增：

- `src/webview/vscodeApi.ts`

提供 `createDefaultVsCodeApi()`，在真实 Webview 中调用 `acquireVsCodeApi`，在测试中通过 props 注入假 API。

### 5. React 端实现

更新 `src/webview/App.tsx`：

- 保存 `task`、`isRunning`、`events`、`runId`、`error` 状态。
- 点击 `Run` 后发送 `startTask`。
- 监听 `window.message` 事件。
- 收到 Host 消息后更新 UI。
- 运行中禁用按钮。

### 6. Extension Host 实现

更新 `src/extension.ts`：

- 监听 `panel.webview.onDidReceiveMessage`。
- 收到 `startTask` 后生成 `runId`。
- 向 Webview 发送：
  - `runStarted`
  - `agentEvent`
  - `agentEvent`
  - `agentEvent`
  - `runFinished`

### 7. 清理与验证

完成后检查：

- 没有临时 TODO。
- 没有未使用导出。
- 文档与代码一致。
- 测试、类型检查、编译全部通过。

验证命令：

```powershell
npm test
npm run typecheck
npm run compile
```

实际验证结果：

- `npm test` 通过，1 个测试文件、3 个测试通过。
- `npm run typecheck` 通过。
- `npm run compile` 通过。

## 验收标准

- React 测试覆盖消息发送和事件渲染。
- Extension Host 能接收 `startTask` 并回推假事件。
- 用户能在 Webview 中看到一次完整假运行事件流。
- 不引入 LLM、真实 runtime 或复杂 UI。
## 本地 VS Code 页面验证记录

验证方式：

- 使用独立 `user-data-dir` 启动 VS Code Extension Development Host。
- 通过命令面板执行 `LoopAgent: Open Panel`。
- 使用 CDP 截图确认 Webview 页面可见。
- 使用 CDP 坐标输入任务并点击 `Run`。

验证发现：

- 初始页面已显示 `LoopAgent`、`Idle`、`Task prompt`、输入框、`Run` 按钮和 `No agent events yet.`。
- 点击 `Run` 后假事件流可显示。
- 发现事件列表出现两个 `Done`，原因是 Extension Host 发送 `agentEvent: Done`，React 收到 `runFinished` 后又追加 `Done`。

修复：

- 新增 `src/extension/fakeRun.ts`，集中生成假 run 消息。
- 删除 Extension Host 中额外的 `agentEvent: Done`。
- 新增 `test/fakeRun.test.ts`，约束假事件流只通过 `runFinished` 产生一个完成标记。

补充验证命令：

```powershell
npm test -- test/fakeRun.test.ts
npm test -- test/App.test.tsx
```

实际结果：

- `test/fakeRun.test.ts` 通过，1 个测试通过。
- `test/App.test.tsx` 通过，3 个测试通过。