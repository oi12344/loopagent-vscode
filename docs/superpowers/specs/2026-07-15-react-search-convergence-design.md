# ReAct 搜索收敛设计

## 目标

让生产 ReAct 模型在每次 `exploreCode` 返回后自行判断证据是否足够：证据足够时立即回答；只有存在与用户问题直接相关的具体证据缺口时才继续搜索，避免为了追求完整而持续探索。

## 当前问题

`createReactAgentRunner` 默认允许四个模型步骤，每步最多三个工具请求。当前生产 system prompt 要求模型使用 `exploreCode` 并逐条验证调用边，却没有定义何时证据已经足够。2026-07-15 的真实验证中，模型在四个步骤内执行八次不同查询，最终因没有返回最终回答而触发 `Reached max ReAct steps: 4`。

## 方案

仅调整 `src/extension/model/providerRegistry.ts` 中的生产 ReAct system prompt，增加以下决策规则：

1. 每次收到 `exploreCode` observation 后，先判断现有证据是否足以直接回答用户问题。
2. 证据足够时立即返回最终回答，不再调用工具。
3. 证据不足时，只能针对一个可明确描述、且与已有查询不重叠的缺口继续调用 `exploreCode`。
4. 不为了穷举所有相关代码、提高完整感或重复确认已经得到支持的事实而继续搜索。
5. 回答只陈述现有源码证据能够支持的结论；证据确实有限时，在回答中说明限制。

模型继续通过现有的 `final` 或 `toolRequests` 结果表达判断，不增加新的工具、状态类型或协议。

## 保持不变

- `maxSteps` 默认值仍为 `4`。
- 每步最多三个工具请求。
- 达到 `maxSteps` 仍返回现有 `runFailed`，不追加关闭工具的强制总结回合。
- Runtime 不基于字符串相似度拦截查询，不替模型判断证据充分性。
- `exploreCode` 的搜索、字符预算、错误处理和可观测事件保持不变。

## 验证

在 `test/providerRegistryCodeContext.test.ts` 的生产 runner 路径捕获发送给模型的 system message，验证其包含三项可观察契约：证据足够立即回答、只有具体缺口才继续搜索、后续查询不得与已有查询重叠。

运行以下验证：

```powershell
npm test -- --run test/providerRegistryCodeContext.test.ts test/reactAgentRunner.test.ts
npm run typecheck
npm test
npm run compile
git diff --check
```

如本地真实 DeepSeek 凭据可用，在唯一的 Extension Development Host 中复用现有调试窗口提问代码实现问题，确认一次有效检索后模型可以在下一模型步骤回答。真实模型结果用于整体路径验证，不替代稳定的自动化契约测试。

## 相关文件

- `src/extension/model/providerRegistry.ts`：生产 ReAct system prompt。
- `src/extension/agent/reactAgentRunner.ts`：保持现有模型/工具循环和安全上限。
- `test/providerRegistryCodeContext.test.ts`：生产接线与 system prompt 契约测试。
- `docs/superpowers/plans/2026-07-15-react-tool-observability-plan.md`：四轮八次搜索的真实验证记录。
