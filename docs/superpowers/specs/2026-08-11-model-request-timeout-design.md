# 模型请求超时设计

## 目标

避免 OpenAI-compatible 模型请求或 SSE 流长期无响应时，ReAct 运行永久占用运行锁且无法落盘最终结果。

## 范围与取舍

- 在 `src/extension/model/openAiCompatibleClient.ts` 为完整请求生命周期设置 120 秒超时，覆盖建立连接和读取 SSE 流。
- 用户主动取消仍沿用原有 `AbortSignal` 语义；超时统一转换为 `ModelProviderError(request_failed)`。
- 不增加设置项、重试器或额外状态机。需要不同超时时间的测试可通过客户端构造参数注入。

## 验证

- `test/openAiCompatibleClient.test.ts` 模拟永不返回的上游，请求应在注入时限后失败。
- 运行定向测试、全量测试、类型检查、构建和 `git diff --check`。
