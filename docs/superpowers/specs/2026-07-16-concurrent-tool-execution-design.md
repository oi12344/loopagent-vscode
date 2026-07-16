# ReAct 单轮并发工具执行设计

## 目标

参考 `D:\zz\claude-code-nb` 的工具调度原则：同一 assistant 消息中的每个工具请求都要实际执行并得到匹配结果；只读工具可以并发，可能改变状态的工具必须串行。移除当前对同名 `exploreCode` 的查询合并和跳过逻辑。

## 范围

- `ReactAgentTool` 增加可选 `isConcurrencySafe(input)` 判断。
- `exploreCode` 声明为并发安全。
- Runner 对连续的并发安全请求并发执行，其他请求逐个执行。
- 同一模型步骤最多接受 10 个工具请求；超过时不执行任何工具并使本次 run 失败。
- 保持 3 个可调用工具步骤和 1 个无工具最终回答步骤。

不新增依赖、配置项、队列、任务规划器或证据评分器。

## 调度规则

1. Runner 收到模型请求后，先检查总数是否超过 10；超过则在写入 assistant tool-call 历史前失败。
2. 对每个请求调用已注册工具的 `isConcurrencySafe(input)`。工具未声明该函数、工具未知或判断抛错时，均视为不安全。
3. 连续的并发安全请求组成一个批次，以 `Promise.all` 并发调用。因为单轮请求总数不超过 10，批次同时运行数量也不超过 10。
4. 不安全请求单独按原始顺序执行；它们不会与任何其他请求并发。
5. 每个请求均生成自己的 `role: "tool"` 消息，保留原 request ID、工具名和真实输出。并发批次完成后仍按模型原始请求顺序写入消息历史，确保后续模型请求稳定且完整。
6. 工具异常延续现有语义：本次 run 发送 `runFailed`。并发批次只包含明确声明为只读的工具。

`exploreCode` 的每个查询均独立传入检索器，不再拼接为换行词袋，也不再返回“已合并”或“已跳过”的合成 observation。

## 提示词与终局

生产提示词不再要求每个工具每轮只能调用一次；保留“证据足够立即回答、仅为具体缺口继续搜索、避免重复确认”的收敛要求。

默认前三个模型步骤仍允许工具。第 4 步不提供工具定义，并仅接受最终文本；provider 违规返回工具请求时不执行，并以 `runFailed` 结束。

## 验证

- 两个同名 `exploreCode` 请求均实际执行，且各自的真实输出按 request ID 回灌。
- 两个并发安全工具在任一请求完成前均已开始执行。
- 非并发安全工具保持串行。
- 11 个请求在调用任何工具前失败；10 个请求可以执行。
- 现有最终回答、取消、未知工具和工具异常语义保持覆盖。
- 运行定向测试、全量测试、类型检查、编译、`git diff --check`，并在唯一 VSIX E2E 窗口中确认同轮多个 `exploreCode` 均显示为实际运行。

## 相关文件

- `src/extension/agent/reactTypes.ts`
- `src/extension/agent/exploreCodeTool.ts`
- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/model/providerRegistry.ts`
- `test/reactAgentRunner.test.ts`
- `test/providerRegistryCodeContext.test.ts`
