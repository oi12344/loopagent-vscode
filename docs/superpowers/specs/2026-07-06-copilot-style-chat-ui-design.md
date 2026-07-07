# 类 Copilot 对话 UI 设计

## 背景

LoopAgent 已经具备 Webview 面板、agent runner 生命周期、DeepSeek OpenAI-compatible provider 和真实 API 最小连通验证。当前 Webview 仍是任务输入加事件列表，无法像真实助手一样展示用户消息、模型流式回答和运行过程。

## 目标

在 VS Code Webview 中实现一个安静、工作型、类 Copilot 的真实对话界面：用户输入消息后，面板展示用户消息、助手状态、过程区和模型返回内容，并能接收 DeepSeek v4 flash 的真实流式结果。

## 范围

- 更新 `src/shared/messages.ts`，为 host 到 Webview 增加结构化助手消息事件。
- 更新 `src/extension/model/modelRunner.ts`，把 provider 的 `contentDelta` 直接转发为 UI 可增量渲染的回答片段。
- 将 provider 的 `reasoningDelta` 映射为安全的高层过程状态，不把原始 `reasoning_content` 展示给用户。
- 重写 `src/webview/App.tsx` 和 `src/webview/styles.css`，呈现对话流、底部输入框、助手过程区、错误状态和运行状态。
- 保留旧 `agentEvent` 的兼容显示路径，降低 fake runner 和旧消息的断裂风险。

## 非目标

- 不实现多轮上下文持久化；每次发送仍作为一次独立 run。
- 不复制 GitHub Copilot 的品牌、图标或专有文案。
- 不展示模型原始思维链或原始 reasoning 文本。
- 不把真实 API key 写入源码、文档、测试、构建产物或仓库配置。

## 消息协议

Webview 到 host 继续使用：

- `startTask`: 用户提交的自然语言任务或消息。

Host 到 Webview 保留既有消息：

- `runStarted`
- `agentEvent`
- `runFinished`
- `runFailed`

新增结构化消息：

- `assistantStarted`: 标记助手消息开始，包含 `provider` 展示名。
- `assistantThinking`: 增加一条高层过程状态，例如“正在连接模型”或“收到模型推理信号”。
- `assistantDelta`: 追加助手回答文本片段。
- `assistantFinished`: 标记助手消息完成。

`reasoningDelta` 只触发一次“收到模型推理信号”类状态，避免把原始推理内容传给 UI。

## UI 行为

- 初始界面直接是可用对话，不做 landing page。
- 对话区显示欢迎占位、用户消息和助手消息。
- 助手消息包含状态行、可折叠过程区和回答正文。
- 过程区默认展开，便于真实调试；内容为高层状态，不包含原始思维链。
- 底部输入框固定在面板底部附近，按钮在运行中禁用并显示 `Sending...`。
- 错误以助手消息的错误状态展示，同时恢复输入能力。

## 验证方式

- `test/modelProvider.test.ts` 覆盖 runner 的结构化流式事件和 reasoning 安全映射。
- `test/App.test.tsx` 覆盖初始对话 UI、发送消息、过程区、流式回答、错误状态和旧 `agentEvent` 兼容。
- `npm test -- --run`
- `npm run typecheck`
- `npm run compile`
- 敏感信息与临时代码扫描。
- 使用 `npm run debug:vscode` 打开唯一 Extension Development Host，配置 DeepSeek provider，用真实 key 发送 `hello`，确认 UI 展示返回内容。
