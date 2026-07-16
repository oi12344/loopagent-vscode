# ReAct 单步同名工具去重设计

## 目标

同一个模型步骤内，每个工具最多实际执行一次。对于同一步的多个 `exploreCode` 请求，Runner 将其查询合并为一次检索；模型收到合并后的结果后，仍可在后续步骤再次调用该工具，从而保留“模型判断证据是否充分”的现有策略。默认最多执行 3 个可调用工具的步骤，随后保证有 1 个关闭工具的最终回答步骤。

## 参考实现结论

`D:\zz\claude-code-nb` 的 `query.ts` 会收集一条 assistant 消息内的全部 `tool_use`，`services/tools/toolOrchestration.ts` 再根据 `isConcurrencySafe` 将只读工具并发执行、写工具串行执行。它不限制同名工具数量，但严格保留每个 `tool_use_id` 与 `tool_result` 的配对，并在全部结果进入消息历史后发起下一模型回合。

参考项目没有通用证据评分器：模型产生 `tool_use` 就继续，没有 `tool_use` 就完成。其 `maxTurns` 是可选限制；配置上限后，最后一轮工具结果也可能没有后续模型回合负责综合。

LoopAgent 不照搬并行策略，只复用“模型决定是否继续、请求与结果完整配对”的原则；重复请求通过合成 observation 反馈模型，真实工具异常继续保持现有 `runFailed` 语义。

## 方案取舍

- 采用：保留模型自评，在固定工具预算之后增加一次 `toolChoice = "none"` 且不提供工具定义的最终回答。
- 不采用独立 Judge：它会增加一次模型调用和新的误判来源，而参考实现也没有该机制。
- 不采用无上限循环：代码问答仍需要明确成本上限和异常收敛边界。

## 行为

`createReactAgentRunner` 在每个 `step` 内维护一个工具名集合，并在执行前处理 `exploreCode`：

1. 收集同一步所有 `exploreCode` 的非空字符串查询，按首次出现顺序去重，并以换行合并。
2. 合并查询不超过现有 1000 字符输入上限时，首个 `exploreCode` request ID 以合并后的查询实际执行一次；真实 observation 明确列出已合并的查询。
3. 其他 `exploreCode` request ID 不执行工具，但各自得到“查询已并入首个 request ID”的合成 observation。
4. 合并输入无效或超过 1000 字符时，安全回退为原有行为：仅执行首个请求，其余请求得到跳过 observation。
5. 非 `exploreCode` 工具仍按原有同名去重规则：首次执行，重复跳过。
6. 进入下一模型步骤时集合重置，因此同一工具可以再次执行。

保留原始 assistant tool-call 消息和每个 request ID 的结果，避免静默改写模型输出或形成不完整的 OpenAI-compatible 工具历史。

`maxToolRequestsPerStep` 改为限制同一步实际会执行的不同工具名称数量，而不是原始模型请求数量。因此 5 个同名 `exploreCode` 请求可合并为 1 次真实搜索；超过上限的不同工具名称仍在执行前失败。

## 提示词

生产 ReAct system prompt 增加：每个 assistant turn 对每个工具最多请求一次；如果仍缺证据，应等待 observation，并在后续 turn 再次请求。

Runtime 校验是最终约束，提示词只用于减少无效重复请求。

## 工具预算与最终回答

`maxSteps` 表示可调用工具的模型步骤数，默认值从 4 调整为 3：

1. 前 3 个步骤使用 `toolChoice = "auto"`。模型可在任一步直接回答并提前结束。
2. 如果第 3 个步骤仍调用工具，Runner 将结果加入消息历史。
3. Runner 追加第 4 个模型步骤；OpenAI-compatible adapter 向 provider 传入 `toolChoice = "none"` 并省略 `tools`，避免兼容 provider 把工具调用标记作为普通文本返回。
4. 最终步骤基于已有证据回答；证据仍不完整时，沿用 system prompt 的约束，明确说明限制。
5. 如果 provider 违反 `toolChoice = "none"` 仍返回工具请求，Runner 不执行这些请求，并按模型协议错误结束。

因此默认总模型调用仍最多为 4 次，但正常运行不会再出现“最后一次工具已执行，却没有模型回合读取结果”的情况。

## 保持不变

- 不把同一工具限制为整次 run 只能调用一次。
- `maxToolRequestsPerStep = 3` 保持数值不变，但按实际不同工具名称计数。
- 同一步不同名称的工具仍按现有顺序执行。
- 未知工具、工具异常和取消行为保持不变。
- 不增加配置项、依赖或通用调度框架。

## 验证

在 `test/reactAgentRunner.test.ts` 覆盖：

- 同一步两个 `exploreCode` 请求合并后只实际执行一次。
- 两个 request ID 均在下一模型回合中得到匹配的 tool message。
- 同一步 5 个 `exploreCode` 查询合并为一次真实检索，且每个 request ID 仍有结果。
- 同一步超过上限的不同工具名称仍在任何工具执行前失败。
- 后续步骤可以再次执行 `exploreCode`。
- 现有查询预览和敏感内容隐藏用例改为跨步骤调用，继续覆盖原行为。
- 达到工具步骤上限后，不再执行工具，而是用 `toolChoice = "none"` 获取最终回答。

在 `test/openAiReactModelTurn.test.ts` 验证最终回答步骤向 provider 传递 `toolChoice = "none"`，同时将 `tools` 设为 `undefined`。在 `test/providerRegistryCodeContext.test.ts` 保留生产 system prompt 的单步同名工具限一次契约。

最终运行定向测试、全量测试、类型检查、生产构建、`git diff --check`，并在唯一 VSIX E2E 窗口中确认每个 `Planning step` 最多出现一次 `Running tool exploreCode`。

## 相关文件

- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/agent/reactTypes.ts`
- `src/extension/agent/openAiReactModelTurn.ts`
- `src/extension/model/types.ts`
- `src/extension/model/providerRegistry.ts`
- `test/reactAgentRunner.test.ts`
- `test/openAiReactModelTurn.test.ts`
- `test/providerRegistryCodeContext.test.ts`
