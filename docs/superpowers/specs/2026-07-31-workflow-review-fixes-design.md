# 工作流正确性与死代码清理修复设计

## 背景

对状态驱动动态工作流（见 `docs/superpowers/specs/2026-07-31-state-driven-dynamic-workflow-design.md`）做了一次设计评审，识别出两个影响线上行为的正确性缺陷，以及两处负资产。本设计是修复它们的最小方案。

## 目标

修复以下四项，每项独立、可单独验证，不改动对外公共契约（工具 schema、事件类型）：

1. **review 路由死循环风险**：review 节点输出无法解析时，`getReviewDecision` 默认返回 `"revise"`，导致 review→被审节点无限路由，唯一兜底是 `maxSteps`。
2. **`cycleState` 死代码**：`CycleManager.evaluateCondition` 给表达式上下文注入了 `cycleState`，但 `DataFlowManager.evaluateExpression` 的 `ExpressionContext` 根本不识别该字段，带 `cycleState` 的 `breakWhen` 表达式必抛错并被 `catch` 吞掉，条件永远不触发。
3. **死代码 `toolDispatcher.ts`**：514 行，带优先级队列 / cost-aware 调度 / 冲突检测 / 退避，但零生产引用（全仓仅 `test/toolDispatcher.test.ts` 引用）。`reactAgentRunner.ts` 另用 `createToolRequestBatches` + `isConcurrencySafe` 实现了并发批次，完全绕开它。
4. **dead config `maxConcurrentExecutions`**：`generatedWorkflowTypes.ts` 声明、`workflowCompiler.ts` 赋默认值 4，但 superstep 运行时 executor 本就逐个串行执行（`dynamicGraphEngine.ts:653-656`），从未读取该字段，是误导性配置。

## 非目标

- 不拆 `dynamicGraphEngine.ts` 的双引擎（07-31 plan Task 7，单独立项）。
- 不拆 `runDynamicGraph` 工具契约。
- 不引入新抽象、新框架。
- 不改 LLM 可见的工具 schema。

## 取舍

### 修复 1：review 默认决策

- **根因**：`getReviewDecision`（`dynamicGraphEngine.ts:712-720`）在 `JSON.parse` 失败且正文不含 `APPROVED` 时返回 `"revise"`。但 `"revise"` 是一个"路由决策"，默认它等于"永远把流程推回去重做"，对无法理解的 review 输出来说是危险默认值。
- **方案**：无法解析时返回 `undefined`。让调用点（`:671`、`:680`）用 `undefined` 表示"决策未知"：
  - 若 review 节点声明了 `when: "revise"` 路由且决策未知 → 该路由不激活（不回退，避免死循环）。
  - 若声明了 `when: "approve"` 路由且决策未知 → 同样不激活。
  - 结果是：决策未知时该 review 节点没有出边被激活，`isActivated` 使后续节点不可达，superstep 收敛后图正常结束，`finalNodes` 包含该 review 节点但无后继。这比"无限回退直到撞 maxSteps"安全得多，且行为可观察、可审计。
- **为何不抛错**：review 节点输出格式不可控（LLM 生成），抛错会中断整个图；让图自然收敛并暴露该节点结果更符合失败语义。
- **测试**：新增 `test/workflow/reviewDecisionFallback.test.ts`，覆盖"review 输出非法 JSON 且不含 APPROVED"场景，断言不触发 revise 回退、图正常结束、`finalNodes` 含该 review。

### 修复 2：cycleState 死代码

- **根因**：`ExpressionContext`（`dataFlowManager.ts:13-17`）只含 `nodes/globalData/currentNode`；`cycleManager.ts:254` 注入的 `cycleState` 在表达式求值时无处可读，任何引用它的表达式都会落入 `unsupportedExpressionMessage` 分支抛错，被 `cycleManager.ts:275-280` 的 `catch` 吞掉，`breakWhen` 静默失效。
- **方案**：该特性从未真正可用（无测试、无文档承诺）。最小修复 = **删除注入**，即从 `cycleManager.ts:246-260` 的表达式上下文中移除 `cycleState` 字段，并保留现有 `catch` 兜底。不扩展 `ExpressionContext`（避免放大未充分设计的表达式语言）。
- **同步清理**：`cycleManager.ts:275-280` 的 `catch` 改为在日志中提示"表达式不支持，请改用 cost-limit/time-limit 或纯节点引用表达式"，减少未来再次踩坑。
- **测试**：`cycleManager` 现有 breakWhen 表达式测试（`test/dynamicGraphCycleIntegration.test.ts`）均用纯节点引用（如 `review.content.includes('APPROVED')`），不受影响；新增一个测试确认"含 cycleState 的表达式会优雅失败（记录原因）而不静默触发"。

### 修复 3：删除 toolDispatcher

- **方案**：删除 `src/extension/agent/toolDispatcher.ts` 和 `test/toolDispatcher.test.ts`。runner 的 `createToolRequestBatches` / `isConcurrencySafe` 是活的、被 `reactAgentRunner.ts:254/460/479` 使用的实现，保留不动。
- **风险**：零生产引用，删除安全。`npm run typecheck` 会确认无残留导入。

### 修复 4：清理 maxConcurrentExecutions

- **方案**：superstep 运行时对 executor 是逐个 `for...of` 串行（`dynamicGraphEngine.ts:654-656`），并发数恒为 1，配置无意义。删除 `generatedWorkflowTypes.ts` 的字段声明与 `workflowCompiler.ts:17,94` 的默认值传递。
- **取舍**：若未来要让 executor 真正并行，应在该字段被消费时再加回，而不是留一个永远不生效的声明误导读者。删字段比留 TODO 更诚实。
- **测试**：现有 `test/workflow/superstepGraphEngine.test.ts` 已覆盖 executor 串行行为，不新增。

## 验证方式

- 受影响测试：`test/workflow/` 全部、`test/dynamicGraphCycleIntegration.test.ts`、`test/cycleSkippedNodeExit.test.ts`、`test/reactAgentRunner.test.ts`。
- 类型检查：`npm run typecheck`（删除 toolDispatcher 后确认无残留引用）。
- 全量测试：`npm test`。
- `git diff --check`。

## 关联

- 关联规格：`docs/superpowers/specs/2026-07-31-state-driven-dynamic-workflow-design.md`
- 关联计划：`docs/superpowers/plans/2026-07-31-workflow-review-fixes-plan.md`
- 关联源码：`src/extension/agent/workflow/dynamicGraphEngine.ts`、`cycleManager.ts`、`dataFlowManager.ts`、`generatedWorkflowTypes.ts`、`workflowCompiler.ts`、`src/extension/agent/toolDispatcher.ts`
- 后续事项（不在本次范围）：双引擎拆分、`runDynamicGraph` 工具拆分。
