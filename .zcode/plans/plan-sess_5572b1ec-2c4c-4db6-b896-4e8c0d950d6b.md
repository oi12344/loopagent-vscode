# 工作流正确性与死代码清理修复（P0 批次）

按 AGENTS.md，这是跨模块、触及公共契约（删文件、改类型字段）的变更，先落地设计 + 计划文档，再按真实路径实现并验证。

## 已确认的事实

- `getReviewDecision`（`dynamicGraphEngine.ts:712-720`）在 review 输出无法解析时返回 `"revise"`，被 `:671/:680` 两处路由判定消费 → review→被审节点无限路由，唯一兜底是 `maxSteps`。
- `cycleManager.ts:254` 给表达式上下文注入 `cycleState`，但 `ExpressionContext`（`dataFlowManager.ts:13-17`）只认 `nodes/globalData/currentNode` → 带 cycleState 的 `breakWhen` 表达式必抛错、被 `:275-280` catch 吞掉，条件永不触发。
- `toolDispatcher.ts`（514 行）全仓仅 `test/toolDispatcher.test.ts` 引用，零生产代码导入；runner 内 `createToolRequestBatches`+`isConcurrencySafe`（`reactAgentRunner.ts:254/460/479`）是活实现。
- `maxConcurrentExecutions` 在 `generatedWorkflowTypes.ts:52` 声明、`workflowCompiler.ts:17,94` 赋默认值 4，但 superstep 运行时 executor 逐个串行（`dynamicGraphEngine.ts:653-656`），从未读取。

## 实施步骤

### 1. 落地文档（AGENTS.md 要求）
- 新增 `docs/superpowers/specs/2026-07-31-workflow-review-fixes-design.md`：背景、4 项目标、非目标、取舍、验证方式。
- 新增 `docs/superpowers/plans/2026-07-31-workflow-review-fixes-plan.md`：任务拆解 + 验收步骤 + 完成记录。

### 2. 修复 review 路由死循环（正确性 bug）
- `dynamicGraphEngine.ts:712-720` 的 `getReviewDecision`：无法解析时返回 `undefined`（不再默认 `"revise"`）。
- 调用点 `:671/:680` 语义已是 `route.when !== getReviewDecision(result)` → 决策为 `undefined` 时该 review 的所有带 `when` 出边都不激活，`isActivated` 让后继不可达，图自然收敛结束。比"撞 maxSteps"安全且可审计。
- 新增失败核心测试 `test/workflow/reviewDecisionFallback.test.ts`：review 输出非法 JSON 且不含 APPROVED → 断言不触发 revise 回退、图正常结束、finalNodes 含该 review。

### 3. 修复 cycleState 死代码（正确性 bug）
- `cycleManager.ts:246-260`：从表达式上下文移除 `cycleState` 字段（该特性从未可用，无测试、无文档承诺）。
- `cycleManager.ts:275-280` 的 `catch`：日志提示"表达式不支持，改用 cost-limit/time-limit 或纯节点引用表达式"。
- 新增测试：含 cycleState 的 breakWhen 表达式优雅失败（记录原因、不静默触发）。

### 4. 删除死代码 toolDispatcher
- 删除 `src/extension/agent/toolDispatcher.ts` 与 `test/toolDispatcher.test.ts`。
- runner 的 `createToolRequestBatches`/`isConcurrencySafe` 是活实现，保留。

### 5. 清理 dead config maxConcurrentExecutions
- 删除 `generatedWorkflowTypes.ts` 字段声明与 `workflowCompiler.ts:17,94` 的默认值传递。
- `test/workflow/superstepGraphEngine.test.ts` 已覆盖 executor 串行，不新增。

### 6. 集中验证（AGENTS.md 第 4 步）
- `npm run typecheck`（确认无 toolDispatcher 残留引用、类型字段删除无破坏）。
- 受影响测试：`test/workflow/`、`test/dynamicGraphCycleIntegration.test.ts`、`test/cycleSkippedNodeExit.test.ts`、`test/reactAgentRunner.test.ts`、`test/toolDispatcher.test.ts`（删除前不再跑）。
- 全量 `npm test`。
- `git diff --check`。

### 7. 清理交付
- 在 plan 文档更新完成记录；审查 diff。

## 取舍说明

- review 默认 `undefined` 而非抛错：review 输出格式由 LLM 决定，抛错会中断整图；让图自然收敛并暴露该节点结果更符合失败语义。
- cycleState 选"删除注入"而非"扩展 ExpressionContext"：避免放大未充分设计的表达式语言；现有 breakWhen 测试全用纯节点引用，不受影响。
- 删 `maxConcurrentExecutions` 字段而非留 TODO：executor 当前恒串行，永不生效的声明会误导读者，删掉更诚实；未来真要并行时在消费点加回。

## 不在本次范围（后续单独立项）

- 拆 `dynamicGraphEngine.ts` 双引擎（07-31 plan Task 7）。
- 拆 `runDynamicGraph` 工具 / schema oneOf。