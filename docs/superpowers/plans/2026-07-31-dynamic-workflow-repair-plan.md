# 动态工作流核心修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 本计划只记录早期的循环重置修复；架构改造请执行 [状态驱动动态工作流改造实施计划](2026-07-31-state-driven-dynamic-workflow-plan.md)，不要继续扩展 `CycleManager/resetNodeForCycle`。

**目标：** 修复 `runDynamicGraph` 的循环执行、结果一致性、预算边界和输入/工具权限校验，使并行 DAG 与 review-fix 闭环在当前 VS Code 扩展运行时中可验证交付。

**架构：** 保留现有 `DynamicGraphEngine -> WorkflowOrchestrator -> ReactAgentRunner` 链路，不引入新的调度框架。循环只允许在已声明依赖路径上回退，节点结果以当前轮次为准；循环高级策略先收缩为硬上限和受限表达式，避免继续暴露未接通的 token、交互和相似度能力。

**技术栈：** TypeScript、Vitest、现有 `WorkflowOrchestrator`、现有 `DataFlowManager`、VS Code Webview 消息协议。

## 全局约束

- 直接在当前 checkout 工作；保留用户已有改动，不创建 worktree，不回滚无关文件。
- 文档和验证记录使用中文；代码标识符、命令和错误原文保留英文。
- 不增加第三方依赖，不实现新的通用工作流框架。
- `maxNodes` 表示图中唯一节点数；另设内部执行次数上限，循环和重试必须消耗同一预算。
- `hardLimit` 定义为“循环边重新进入的最大轮数”，初始执行不计入循环轮数。
- 循环目标必须是起点节点依赖链上的祖先；不支持任意跨图跳转或嵌套循环。
- 本计划不实现可恢复的动态图 checkpoint；中断图只能取消并由父 ReAct 重新发起。

## 当前边界与验收结果

- 生产入口是 `src/extension/model/providerRegistry.ts` 注册的 `runDynamicGraph`。
- 核心实现文件为 `src/extension/agent/dynamicWorkflowTools.ts`、`src/extension/agent/workflow/dynamicGraphEngine.ts`、`src/extension/agent/workflow/dataFlowManager.ts`、`src/extension/agent/workflow/cycleManager.ts`、`src/extension/agent/workflowOrchestrator.ts`。
- 当前循环测试允许“审查执行 2 次、修复执行 1 次”，因此不能作为闭环验收。
- 当前 `npm run typecheck` 仍有动态工作流类型错误及其他工作区错误；实现阶段先记录基线，动态工作流改动不得增加错误，是否清理 Java 索引等无关错误另立任务。

---

### Task 1: 建立基线与收紧配置契约

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/extension/agent/workflowOrchestrator.ts`（仅在需要暴露共享执行预算时）
- Test: `test/dynamicWorkflowTools.test.ts`
- Test: `test/dynamicGraphWorkflow.test.ts`

**Interfaces:**
- `DynamicGraphDefinition.maxNodes` 继续限制唯一节点数。
- `DynamicGraphEngineOptions` 或 definition 增加一个内部 `maxExecutions`，默认值必须与 orchestrator 的 `maxSubagentsPerRun` 对齐为 50；不要让工具输入自行覆盖该安全上限。
- 引擎在创建子代理前检查执行预算，超限返回带有已执行数量和上限的稳定错误，不等到 orchestrator 中途抛出。

- [ ] **Step 1: 写失败测试。**
  - 添加 51 个无依赖初始节点的测试，断言图在第 51 次执行前以预算错误结束。
  - 添加循环重复执行消耗执行预算的测试，证明 `maxNodes` 不会掩盖循环执行次数。
  - 添加 `maxNodes` 仍只约束唯一节点数的测试。
- [ ] **Step 2: 运行测试确认失败。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts test/dynamicGraphWorkflow.test.ts`
  - Expected: 新增预算断言失败，现有实现会把限制交给 orchestrator 或不报稳定错误。
- [ ] **Step 3: 实现最小预算检查。**
  - 在 `executeNode` 创建子代理前递增执行计数；失败、取消和重试都计入。
  - 把预算错误转换为节点失败或图级错误，不能遗留 pending 节点且仍返回成功。
  - 不修改 resolver 的节点数量语义。
- [ ] **Step 4: 运行受影响测试。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts test/dynamicGraphWorkflow.test.ts`
  - Expected: 新增预算测试和原有 DAG/数据流测试通过。

### Task 2: 修复循环切片和当前轮结果

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/workflow/cycleManager.ts`
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Test: `test/dynamicGraphCycleIntegration.test.ts`
- Test: `test/cycleManager.test.ts`

**Interfaces:**
- 新增一个引擎内部函数 `resetCycleSlice(fromNodeId, toNodeId)`；不暴露给工具调用方。
- `CycleManager` 返回明确的 `triggered` 或 `stopped` 决策，调用方用 cycle id 发出一次 `CycleStopped`。
- `completedNodes` 和 `context.nodes.get(id).result` 必须始终指向同一轮的最新结果。

- [ ] **Step 1: 写失败集成测试。**
  - 使用 `implement -> review -> fix` 图：首轮 review 返回问题，第二轮 review 返回 `APPROVED`。
  - 断言 `implement` 执行 1 次、`review` 执行 2 次、`fix` 执行 1 次；若 hardLimit 允许继续，再用第三轮问题断言 `fix` 也会重跑。
  - 断言返回的 `results.review.content` 是最后一轮内容，不是首轮内容。
  - 断言停止事件的 `cycleId` 是配置的 cycle id，且只出现一次。
- [ ] **Step 2: 运行测试确认失败。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicGraphCycleIntegration.test.ts`
  - Expected: 当前实现只重跑 review，无法满足 fix 重跑和最新结果断言。
- [ ] **Step 3: 实现循环切片重置。**
  - 验证 `to` 是 `from` 的依赖祖先；循环配置不满足时在执行前拒绝。
  - 重置 `to` 到 `from` 之间所有循环路径节点：清空 result/subagentId/时间戳，保留累计 attempts 和执行历史。
  - 重置后只由统一调度入口重新扫描 ready 节点，禁止在多个 Promise 回调中重复启动。
  - 写回最新结果时覆盖 Map 中旧值，并同步 `context.nodes`、数据流记录和最终 JSON。
- [ ] **Step 4: 运行循环回归。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicGraphCycleIntegration.test.ts test/cycleManager.test.ts test/dynamicGraphWorkflow.test.ts`
  - Expected: 所有循环轮次、最终结果、停止事件和原 DAG 行为通过。

### Task 3: 收缩并修复退出表达式

**Files:**
- Modify: `src/extension/agent/workflow/cycleManager.ts`
- Modify: `src/extension/agent/workflow/dataFlowManager.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Test: `test/dynamicGraphWorkflow.test.ts`
- Test: `test/dynamicGraphCycleIntegration.test.ts`

**Interfaces:**
- 第一版只保留 `hardLimit`、`expression`、`cost-limit/time-limit` 中已经有可靠运行时来源的能力；未接通的 `interactive` 和 `no-progress` 不再出现在工具 schema 中。
- 表达式优先级固定为：否定/包含与原子引用 -> 比较 -> `&&`。
- `SubagentResult.toolCallCount` 在没有真实计数来源前不得用于 token 预算。

- [ ] **Step 1: 写失败表达式测试。**
  - 添加 `a.status === 'completed' && b.status === 'completed'`、否定组合和引号内 `&&` 的测试。
  - 添加 malformed comparison、未知节点和非法 cycle exit 类型的测试。
- [ ] **Step 2: 运行测试确认失败。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicGraphWorkflow.test.ts test/dynamicGraphCycleIntegration.test.ts`
  - Expected: 组合比较表达式或当前未声明的退出类型暴露失败。
- [ ] **Step 3: 实现最小修复。**
  - 先拆 `&&`，再拆比较运算；保留现有受限表达式，不引入 JavaScript `eval`。
  - 删除或隐藏没有生产调用链的 `interactive`、`no-progress`、伪 token 预算；不要保留“看似支持但实际失效”的字段。
  - 退出条件评估错误必须让图失败并携带表达式与已知节点 id，不能静默继续。
- [ ] **Step 4: 运行数据流回归。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicGraphWorkflow.test.ts test/dynamicGraphCycleIntegration.test.ts`
  - Expected: 原子引用、JSON path、输入映射和组合条件全部通过。

### Task 4: 失败关闭的图配置与工具权限

**Files:**
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/extension/agent/workflow/toolRouter.ts`
- Modify: `src/extension/agent/workflow/roleRegistry.ts`（仅在错误信息需要共享常量时）
- Test: `test/dynamicWorkflowTools.test.ts`
- Test: `test/workflow/toolRouter.test.ts`

- [ ] **Step 1: 写失败校验测试。**
  - cycle id 重复、`from/to` 不存在、非祖先回退、非法 breakWhen、非正 hardLimit 都必须拒绝。
  - executor 使用未知 `toolHints` 必须拒绝或得到空工具集，不能回退到完整 executor 工具集。
  - 测试 `initialNodes`、resolver 生成节点和 cycle 节点 id 的错误信息包含路径。
- [ ] **Step 2: 运行测试确认失败。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts test/workflow/toolRouter.test.ts`
- [ ] **Step 3: 实现校验。**
  - `parseCycles` 使用同一套 node id 规则，校验数组类型、唯一 id、节点引用、退出条件类型和数值范围。
  - 在动态工具入口对 `toolHints` 与 `availableTools` 做显式校验；显式提示没有匹配项时失败关闭。
  - 更新工具 schema 和 system prompt，使其只描述实际支持的字段。
- [ ] **Step 4: 运行权限回归。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts test/workflow/toolRouter.test.ts test/workflowOrchestrator.test.ts`
  - Expected: 角色白名单仍生效，错误提示不再扩大权限。

### Task 5: 图事件与中断语义收口

**Files:**
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `src/shared/messages.ts`
- Modify: `src/extension.ts`
- Modify: `src/webview/App.tsx`
- Test: `test/providerRegistryCodeContext.test.ts`
- Test: `test/App.test.tsx`

**范围说明：** 这是核心闭环通过后的可选切片；不在前四项失败时并行开发。

- [ ] **Step 1: 写事件契约测试。**
  - 图事件至少包含 graph id、cycle id、node id、iteration、status 和 reason。
  - Webview 收到 `CycleTriggered`、`CycleStopped`、`GraphCancelled` 后能更新现有 workflow progress，不要求先做新的可视化画布。
- [ ] **Step 2: 实现最小事件桥接。**
  - provider 订阅 graph engine 事件，并复用现有 host message 队列；不把完整 node result 复制到每条状态消息。
  - UI 继续使用现有扁平列表，增加轮次/停止原因文本即可。
- [ ] **Step 3: 明确中断行为。**
  - 外部 signal abort 后统一发 `GraphCancelled`，父 runner 不把部分图误报为正常完成。
  - 不把动态图状态写入现有 React checkpoint；恢复时重新执行父工具调用。
- [ ] **Step 4: 运行 UI/协议回归。**
  - Run: `npm.cmd test -- --reporter=dot test/providerRegistryCodeContext.test.ts test/App.test.tsx test/dynamicGraphWorkflow.test.ts`

### Task 6: 文档、验收与交付

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-bidirectional-graph-design.md`（标记过时方案和保留范围）
- Modify: `docs/superpowers/plans/2026-07-30-dynamic-cycle-exit-strategies.md`（删除未实现策略或标注后续事项）
- Modify: `docs/development.md`（补充动态图限制、预算和不可恢复语义）
- Test: 受影响测试文件

- [ ] **Step 1: 运行纵向验收。**
  - Run: `npm.cmd test -- --reporter=dot test/dynamicGraphWorkflow.test.ts test/dynamicGraphCycleIntegration.test.ts test/dynamicWorkflowTools.test.ts test/workflow/toolRouter.test.ts test/workflowOrchestrator.test.ts`
  - Expected: 核心测试全通过，循环闭环断言为 review/fix 的真实轮次和最新结果。
- [ ] **Step 2: 运行工程检查。**
  - Run: `npm.cmd run typecheck`
  - Expected: 动态工作流相关错误为 0；若 Java/其他现有错误仍在，记录基线差异，不把它们伪装成此次修复结果。
  - Run: `npm.cmd run compile`
  - Expected: esbuild 成功产出扩展 bundle。
  - Run: `git diff --check`
  - Expected: 无新增空白错误。
- [ ] **Step 3: 做一次真实入口验证。**
  - 在同一个 LoopAgent Extension Development Host 中执行 `runDynamicGraph`：两个并行只读节点加一个依赖两者的 reviewer；再执行一次 review-fix 循环。
  - 验证节点并行、依赖输入、循环轮次、停止原因和取消行为，不使用新的调试窗口。
- [ ] **Step 4: 集中审查 diff。**
  - 确认没有 `console.log` 调试残留、未接通 schema 字段、死的 CycleManager API 或新增未跟踪临时脚本。
  - 只提交动态工作流修复及其文档/测试；不吸收当前工作区的 Java、UI 试验和脚本改动。

## 暂不做的事项

- 不在本轮实现任意双向图、嵌套循环、跨分支回退或循环可视化画布。
- 不在没有真实 provider token usage 的情况下实现 token 成本估算。
- 不把动态图节点状态塞进通用 conversation checkpoint；若未来需要断点续跑，应另立持久化设计。
- 不因计划需要而修复与动态图无关的 Java AST、模型客户端或其他已有类型错误。

## 完成标准

只有以下条件全部满足，才能称为核心修复完成：

1. review-fix 循环按定义轮数执行，review 和 fix 的重复执行次数正确。
2. 返回结果、节点上下文和 data-flow history 都反映最后一轮。
3. hardLimit、执行预算、取消和非法配置不会让图以假成功结束。
4. 组合表达式和输入映射测试通过，未知 tool hint 不扩大权限。
5. 动态工作流相关 typecheck、编译、目标测试和真实入口验证有明确结果。
