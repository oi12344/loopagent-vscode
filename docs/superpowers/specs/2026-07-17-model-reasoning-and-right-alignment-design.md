# 模型推理与右侧对话设计

## 目标

让 `LoopAgent` 的 `Process` 只展示模型 provider 在流中实际返回的 `reasoningDelta` 文本，不再将代码上下文、规划步骤或工具运行事件混入模型思考。同时将用户请求明确呈现为类似 Copilot 的右侧对话气泡。

## 范围

- 在 `HostToWebviewMessage` 增加 `assistantReasoningDelta`，携带一个模型推理文本分段。
- `modelRunner` 将每个 `ModelStreamEvent.reasoningDelta.content` 原样转发为该事件。
- Webview 为助手消息维护单独的 `reasoning` 字符串；`Process` 仅在此字符串非空时显示。
- `assistantThinking` 继续驱动“思考中”状态，但不显示为 `Process` 内容。
- `agentEvent` 继续由 Host 发送给运行时兼容路径，但不显示为模型思考。
- 用户消息气泡保持右对齐，并在宽侧栏限制为较短的可读宽度；窄侧栏回退为可用宽度。

## 非目标

- 不生成、总结、推断或补全模型未返回的隐藏思考内容。
- 不为 `ReactAgentRunner` 补造推理文本；该路径没有 provider 流式 reasoning 时只显示当前运行状态。
- 不展示工具请求或工具结果为模型思考，不新增工具面板或运行历史。
- 不改变模型请求、工具执行、`WebviewToHostMessage`、模型选择或错误语义。
- 不新增依赖、图标库、图片资源或新的持久化状态。

## 数据流

```text
provider.stream()
  -> ModelStreamEvent.reasoningDelta
  -> HostToWebviewMessage.assistantReasoningDelta
  -> AssistantTurn.reasoning
  -> Process details 的逐段推理文本
```

`contentDelta` 仍写入助手回答，`assistantThinking` 仍驱动思考状态，`agentEvent` 不再写入 `AssistantTurn`。因此 `Process` 的内容可被解释为模型实际返回的推理，而非 Host 侧运行日志。

## 用户可见行为

1. provider 返回 reasoning 分段时，当前助手消息出现并展开 `Process`，文本按流式顺序追加。
2. provider 开始回答后，推理内容仍可展开阅读；运行完成后沿用现有逻辑默认折叠，用户可以重新展开。
3. 模型没有返回 reasoning 分段时，不显示空的 `Process`；界面只显示思考、回答、完成或错误状态。
4. 工具调用、上下文构建和 ReAct 规划不会被标为模型思考。
5. 用户请求显示在聊天区右侧，`You` 元数据同样右对齐；在窄侧栏中气泡最多占可用内容宽度，不产生水平滚动。

## 错误与边界

- 推理流可以在回答前、回答中或回答后到达，Webview 仅按收到顺序追加字符串。
- 运行失败时保留已有 `role="alert"` 与错误文本；已有 reasoning 不被删除。
- 当 provider 未发送 `reasoningDelta` 或使用 `ReactAgentRunner` 时，`Process` 缺席是正常状态，不以占位文案伪造思考。
- 仅显示 provider 已返回的字符串，不将工具输入、工作区上下文或本地日志作为 reasoning 转发。

## 验证

- `test/modelRunnerContext.test.ts` 验证 `reasoningDelta` 被原样映射到新 Host 事件。
- `test/modelProvider.test.ts` 更新既有 provider 流映射断言，使其验证原始 reasoning 文本被转发。
- `test/App.test.tsx` 验证 `Process` 显示推理文本、忽略 `assistantThinking` 与 `agentEvent` 的通用运行文案，并在完成后折叠。
- 在 `test/App.test.tsx` 验证用户消息拥有右侧气泡类与既有提交契约。
- 运行 `npm test -- --run test/modelRunnerContext.test.ts test/modelProvider.test.ts test/App.test.tsx`、`npm run typecheck`、`npm test`、`npm run compile` 和 `git diff --check`。
- 在唯一的 Extension Development Host 中使用能返回 reasoning 的模型，确认 `Process` 不含工具日志且用户消息位于右侧。

## 相关文件

- `src/shared/messages.ts`
- `src/extension/model/modelRunner.ts`
- `src/webview/App.tsx`
- `src/webview/styles.css`
- `test/modelRunnerContext.test.ts`
- `test/modelProvider.test.ts`
- `test/App.test.tsx`
