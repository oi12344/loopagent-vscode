# ReAct 单步同名工具去重设计

## 目标

同一个模型步骤内，每个工具最多实际执行一次。模型收到首个工具结果后，仍可在后续步骤再次调用该工具，从而保留“模型判断证据是否充分”的现有策略。

## 参考实现结论

`D:\zz\claude-code-nb` 的 `query.ts` 会收集一条 assistant 消息内的全部 `tool_use`，`services/tools/toolOrchestration.ts` 再根据 `isConcurrencySafe` 将只读工具并发执行、写工具串行执行。它不限制同名工具数量，但严格保留每个 `tool_use_id` 与 `tool_result` 的配对，并在全部结果进入消息历史后发起下一模型回合。

LoopAgent 不照搬并行策略，只复用“请求与结果完整配对”的原则；重复请求通过合成 observation 反馈模型，真实工具异常继续保持现有 `runFailed` 语义。

## 行为

`createReactAgentRunner` 在每个 `step` 内维护一个工具名集合：

1. 首次出现的工具名正常交给 `toolRegistry.invoke`。
2. 同一步再次出现相同工具名时，不执行工具。
3. Runner 发送一条 `agentEvent`，说明该重复调用已跳过。
4. Runner 为重复请求追加匹配其 request ID 的 `tool` 消息，内容说明每个步骤内同名工具只能执行一次，并要求模型先评估已有结果。
5. 进入下一模型步骤时集合重置，因此同一工具可以再次执行。

保留原始 assistant tool-call 消息和每个 request ID 的结果，避免静默改写模型输出或形成不完整的 OpenAI-compatible 工具历史。

## 提示词

生产 ReAct system prompt 增加：每个 assistant turn 对每个工具最多请求一次；如果仍缺证据，应等待 observation，并在后续 turn 再次请求。

Runtime 校验是最终约束，提示词只用于减少无效重复请求。

## 保持不变

- 不把同一工具限制为整次 run 只能调用一次。
- `maxSteps = 4` 和 `maxToolRequestsPerStep = 3` 保持不变。
- 同一步不同名称的工具仍按现有顺序执行。
- 未知工具、工具异常、取消和触顶 `runFailed` 行为保持不变。
- 不增加配置项、依赖或通用调度框架。

## 验证

在 `test/reactAgentRunner.test.ts` 覆盖：

- 同一步两个 `exploreCode` 请求只实际执行第一个。
- 两个 request ID 均在下一模型回合中得到匹配的 tool message。
- 后续步骤可以再次执行 `exploreCode`。
- 现有查询预览和敏感内容隐藏用例改为跨步骤调用，继续覆盖原行为。

在 `test/providerRegistryCodeContext.test.ts` 验证生产 system prompt 包含单步同名工具限一次的契约。

最终运行定向测试、全量测试、类型检查、生产构建、`git diff --check`，并在唯一 VSIX E2E 窗口中确认每个 `Planning step` 最多出现一次 `Running tool exploreCode`。

## 相关文件

- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/model/providerRegistry.ts`
- `test/reactAgentRunner.test.ts`
- `test/providerRegistryCodeContext.test.ts`
