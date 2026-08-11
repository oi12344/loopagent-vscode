# DeepSeek 工具历史 Thinking 模式修复设计

## 目标

避免 ReAct 工具循环的最终回答请求被 DeepSeek 以缺少 `reasoning_content` 为由拒绝。

## 根因与取舍

工具调用阶段携带 `tools`，Provider 会禁用 thinking；最终回答阶段不再携带 `tools`，旧实现恢复用户配置的 thinking，导致同一请求历史混用两种模式。工具阶段生成的 assistant 消息没有 `reasoning_content`，重新启用 thinking 后会触发上游参数校验错误。

修复限定在 `src/extension/model/providers/deepseekProvider.ts`：当前请求携带工具，或消息历史已经包含工具调用时，均保持 `thinking: disabled`。纯对话请求继续使用用户配置，不修改通用 OpenAI-compatible 序列化逻辑。

## DSML 工具调用兼容

ReAct 最终回答阶段使用 `toolChoice: none`，但旧实现同时删除了 `tools`。通用客户端因此无法把 `tool_choice: none` 写入请求体，DeepSeek 在已有工具历史下仍可能把内部 DSML 工具调用作为普通文本返回。

最终回答请求继续携带当前工具定义，并显式发送 `tool_choice: none`。这让工具协议和禁用选择同时存在。

实际部署验证又确认：`deepseek-v4-flash` 在首轮 `tool_choice: auto` 时也可能把内部 `<｜｜DSML｜｜tool_calls>` 放入普通 `delta.content`，而不是标准 `delta.tool_calls`。`src/extension/agent/openAiReactModelTurn.ts` 因此增加精确格式兼容：将完整 DSML 调用转换为现有 `toolRequests`，继续复用工具注册、参数校验和执行链；格式不完整或在 `tool_choice: none` 时出现工具调用则报错，不把协议文本作为最终答案展示。

该兼容不引入 XML 依赖，也不修改普通文本或标准 OpenAI 工具调用路径。

## 验证

- `npm test -- test/openAiReactModelTurn.test.ts test/deepseekProvider.test.ts test/openAiCompatibleClient.test.ts`
- `npm run typecheck`
- `npm run compile`
- `git diff --check`
