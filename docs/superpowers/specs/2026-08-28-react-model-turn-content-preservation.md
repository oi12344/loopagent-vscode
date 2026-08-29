# ReAct 模型层：保留工具调用前的文本并放宽 finishReason 校验

## 目标

修复 `openAiReactModelTurn` 的两处行为问题：

1. 模型在返回工具调用时同时输出的自然语言会被丢弃。
2. 部分 OpenAI 兼容 provider 在返回 `tool_calls` 时 `finishReason` 可能缺失或误报为 `stop`，导致 run 被不必要中断。

## 范围

- `src/extension/agent/openAiReactModelTurn.ts`
- `test/openAiReactModelTurn.test.ts`（回归测试）

## 改动

1. `createToolRequests` 新增 `content` 参数。
   - 原生 `tool_calls` 分支：把流式累加的 `content` 传入，结果 `assistantMessage.content` 不再恒为 `""`。
   - DSML 分支：传入 `stripDsmlToolCalls(content)`（剔除 `<｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls>` 标签后的自然语言前缀）。
2. 移除 `finishReason !== "tool_calls"` 的硬抛错，改为只要成功解析出 `tool_calls` 即采用。原有的矛盾检查保留：`finishReason === "tool_calls"` 但解析不到任何调用时仍抛 `Model finished with tool_calls but returned no tool calls`。
3. 新增 `stripDsmlToolCalls`，仅保留 DSML 标签外的自然语言文本。

## 取舍

- 保留 content 后，DeepSeek / Claude 等在调用工具前写出的解释文本会进入对话历史（`reactAgentRunner` 在 toolRequests 分支把 `result.assistantMessage` 推入 `messages`），改善后续推理的连贯性。
- 放宽 `finishReason` 是为兼容异构 provider。若调用本身解析失败，`createToolRequests` 内部仍会因缺少 `id` / `name` 抛错，安全性未削弱。

## 验证

- `npx vitest run test/openAiReactModelTurn.test.ts`：16 项全部通过，含 3 项新增回归（content 前置文本保留、非 tool_calls 的 finishReason 被接受、DSML 自然语言前缀保留）。

## 关联

- `reactAgentRunner.ts:219` 在 `toolRequests` 分支把 `result.assistantMessage` 推入消息历史；webview 的 `assistantDelta` / `AssistantMessage` 现可正确渲染该文本。
- `reactAgentRunner.ts:200-212`：final answer step 把 `toolRequests` 的 `assistantMessage.content` 作为最终答案流式输出，content 保留后亦更完整。
