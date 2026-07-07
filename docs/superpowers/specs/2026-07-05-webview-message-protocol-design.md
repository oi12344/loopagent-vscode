# Webview 消息协议最小设计

## 目标

打通 React Webview 与 VS Code Extension Host 的双向通信链路，为后续接入 LoopAgent runtime 做准备。

本阶段实现一个最小假运行流程：用户在 Webview 输入任务并点击 `Run` 后，Webview 向 Extension Host 发送 `startTask` 消息；Extension Host 创建一个临时 `runId`，再向 Webview 推送运行开始、事件和结束消息。

## 非目标

本阶段不实现以下内容：

- 不接入 LLM。
- 不实现真实 agent 状态机。
- 不执行文件、shell、patch 或 git 操作。
- 不持久化 run 记录。
- 不做复杂事件列表、权限审批或错误恢复 UI。

## 消息边界

React Webview 只负责展示 UI 和发送用户意图。

Extension Host 负责接收消息、创建运行标识、调度后续 runtime，并把事件推送回 Webview。

双方共享消息类型，避免字符串散落在组件和 extension 代码中。

## 消息类型

### Webview 发往 Extension Host

```ts
type WebviewToHostMessage = {
  type: "startTask";
  task: string;
};
```

### Extension Host 发往 Webview

```ts
type HostToWebviewMessage =
  | { type: "runStarted"; runId: string; task: string }
  | { type: "agentEvent"; runId: string; message: string }
  | { type: "runFinished"; runId: string }
  | { type: "runFailed"; runId: string; message: string };
```

## 用户可见行为

用户打开 `LoopAgent: Open Panel` 后：

1. 输入任务。
2. 点击 `Run`。
3. 按钮进入运行态并显示 `Running...`。
4. 面板展示事件：
   - `Run started`
   - `Building context`
   - `Calling model placeholder`
   - `Done`
5. 运行结束后按钮恢复可用。

如果输入为空，按钮保持禁用，不发送消息。

## 关键设计决策

### 使用共享类型文件

新增 `src/shared/messages.ts`，供 React Webview 和 Extension Host 共同使用。

这样后续接入真实 runtime 时，可以在同一位置扩展消息协议。

### 使用 Webview API 包装层

新增 `src/webview/vscodeApi.ts`，把 `acquireVsCodeApi` 包在一个小函数里。

原因是测试环境没有 VS Code Webview 全局对象。通过包装层可以在测试中注入假的 `postMessage`，避免组件直接依赖全局变量。

### 假 runner 放在 Extension Host

本阶段的假事件流由 Extension Host 发送，而不是 React 自己模拟。

这样能真实验证双向消息链路：

- Webview 发起任务
- Extension Host 接收任务
- Extension Host 回推事件
- Webview 渲染事件

后续真实 agent runtime 可以替换假 runner，不需要重写 UI 消息结构。

## 涉及文件

- `src/shared/messages.ts`
- `src/webview/vscodeApi.ts`
- `src/webview/App.tsx`
- `src/extension.ts`
- `test/App.test.tsx`

## 验证方式

必须执行：

```powershell
npm test
npm run typecheck
npm run compile
```

测试至少覆盖：

- 空输入不能发送 `startTask`。
- 输入任务后点击 `Run` 会发送 `startTask`。
- 运行中按钮禁用。
- 收到 Host 消息后渲染事件列表。
- 收到 `runFinished` 后恢复可运行状态。

## 后续工作

下一步可以实现最小 `AgentRun` 与 `EventLog`：

- 从假 runner 替换为 runtime 事件源。
- 把每个 run 的事件写入 JSONL。
- Webview 根据真实事件渲染进度。

这些变更必须另行补充中文设计和计划文档。
