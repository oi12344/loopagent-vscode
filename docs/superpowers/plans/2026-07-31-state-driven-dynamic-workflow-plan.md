# 状态驱动动态工作流改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将大模型生成的动态工作流从“直接生成循环配置”改造成“语义计划编译为有向循环图，再由状态快照驱动执行”。

**Architecture:** 模型只输出节点任务、前置关系、上下文来源和审核关系；`workflowCompiler.ts` 将其编译为不可变图和状态通道。`dynamicGraphEngine.ts` 采用 superstep：统一快照、执行节点、批量提交写入、根据状态选择下一批节点。旧 DAG 在入口处转换，运行时不保留第二套循环实现。

**Tech Stack:** TypeScript、Vitest、现有 `DynamicGraphEngine`、`WorkflowOrchestrator`、VS Code Extension Host；不增加第三方依赖。

## Global Constraints

- 直接在当前 checkout 开发；保留用户已有改动，不创建或切换 worktree。
- 文档、测试说明和错误说明使用中文；代码标识符、命令、路径和错误原文可使用英文。
- 不新增 LangGraph 依赖，不实现持久化 checkpoint、时间旅行、新的动态 fan-out 或分布式执行；已有 resolver 通过兼容规则保留。
- `maxNodes` 只限制图节点数；`maxSteps` 和 `maxExecutions` 单独限制运行步骤和执行次数。
- `applyEdit`、`runCommand` 等副作用节点第一阶段按步骤串行，避免并行写工作区。
- 新语义计划运行时不得用 `CycleManager`、`resetNodeForCycle` 或 `pending-retry` 表达循环；旧输入兼容路径在迁移完成前可保留，但不得被新工具提示使用。

---

### Task 1: 固化新计划契约和迁移边界

**Files:**
- Create: `src/extension/agent/workflow/generatedWorkflowTypes.ts`
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Test: `test/workflow/generatedWorkflowTypes.test.ts`
- Reference: `docs/superpowers/specs/2026-07-31-state-driven-dynamic-workflow-design.md`

**Interfaces:**
- Produces `GeneratedWorkflowPlan`、`GeneratedWorkflowNode`、`CompiledWorkflowGraph`、`WorkflowCompileError`。
- `GeneratedWorkflowPlan` 支持可选 `initialState`；`DynamicGraphDefinition` 保留旧入口类型，但新增 `maxSteps`、`maxExecutions` 作为运行限制。

- [ ] **Step 1: 写失败测试**

```ts
it("accepts a semantic plan without cycles or expressions", () => {
  const plan = {
    nodes: [
      { id: "draft", task: "write draft" },
      { id: "review", task: "review draft", after: ["draft"], reviews: "draft" },
    ],
  };
  expect(parseGeneratedWorkflowPlan(plan).nodes).toHaveLength(2);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/generatedWorkflowTypes.test.ts`

Expected: FAIL because the new parser and types do not exist.

- [ ] **Step 3: 实现最小契约**

定义上文规格中的四个类型和一个 `parseGeneratedWorkflowPlan(input: unknown)`。解析器只接受记录、非空节点数组、唯一 ID、字符串 `task`，拒绝 `cycles`、任意表达式和未知字段；错误中包含字段路径。

- [ ] **Step 4: 运行通过测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/generatedWorkflowTypes.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交独立变更**

```powershell
git add src/extension/agent/workflow/generatedWorkflowTypes.ts src/extension/agent/workflow/dynamicGraphTypes.ts test/workflow/generatedWorkflowTypes.test.ts
git commit -m "feat: define state-driven workflow plan contract"
```

### Task 2: 实现确定性工作流编译器

**Files:**
- Create: `src/extension/agent/workflow/workflowCompiler.ts`
- Test: `test/workflow/workflowCompiler.test.ts`
- Modify: `src/extension/agent/workflow/generatedWorkflowTypes.ts`

**Interfaces:**
- Consumes `GeneratedWorkflowPlan`。
- Produces `CompiledWorkflowGraph`，包含 `nodes`、`routes`、`channels`、`expansionRules`、`limits`。
- Exposes `compileGeneratedWorkflow(plan: GeneratedWorkflowPlan): CompiledWorkflowGraph`。

- [ ] **Step 1: 写失败测试**

```ts
it("compiles review semantics into an approved exit and a revise return", () => {
  const graph = compileGeneratedWorkflow({
    nodes: [
      { id: "draft", task: "draft" },
      { id: "review", task: "review", after: ["draft"], reviews: "draft" },
    ],
  });
  expect(graph.routes).toEqual([
    { from: "draft", to: "review", kind: "normal" },
    { from: "review", to: "__end__", when: "approve" },
    { from: "review", to: "draft", when: "revise" },
  ]);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/workflowCompiler.test.ts`

Expected: FAIL because compilation is not implemented.

- [ ] **Step 3: 实现校验和编译**

按以下顺序实现纯函数：节点 ID 校验、引用校验、普通边生成、审核节点终端/后继校验、审核路由生成、输出通道命名、初始状态和默认限制注入。错误统一使用 `WorkflowCompileError`，包含 `path`、`code`、`message`。

- [ ] **Step 4: 覆盖弱模型失败输入**

增加重复 ID、未知 `after`、未知 `reviews`、空任务、审核节点缺少被审核节点、超过 `maxNodes` 和不支持字段的测试。测试必须断言错误路径，不能只断言抛出了异常。

- [ ] **Step 5: 运行编译器测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/workflowCompiler.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交独立变更**

```powershell
git add src/extension/agent/workflow/workflowCompiler.ts src/extension/agent/workflow/generatedWorkflowTypes.ts test/workflow/workflowCompiler.test.ts
git commit -m "feat: compile semantic workflow plans"
```

### Task 3: 实现版本化状态和写入合并

**Files:**
- Create: `src/extension/agent/workflow/workflowState.ts`
- Test: `test/workflow/workflowState.test.ts`
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`

**Interfaces:**
- Exposes `createWorkflowState(initialValues)`、`readSnapshot()`、`commitWrites(snapshot, writes)`。
- `commitWrites` 返回新快照和冲突错误，不修改旧快照。

- [ ] **Step 1: 写失败测试**

```ts
it("rejects two single-writer updates in one step", () => {
  const state = createWorkflowState({ "outputs.draft": "old" });
  const snapshot = state.readSnapshot();
  expect(() => state.commitWrites(snapshot, [
    { channel: "outputs.draft", value: "a", mode: "single", nodeId: "a" },
    { channel: "outputs.draft", value: "b", mode: "single", nodeId: "b" },
  ])).toThrow("StateWriteConflict");
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/workflowState.test.ts`

Expected: FAIL because state storage and reducer logic do not exist.

- [ ] **Step 3: 实现三种固定合并策略**

实现 `single`、`append`、`merge`。合并按节点 ID 稳定排序；`merge` 遇到重复字段抛出冲突。提交成功后递增 `version` 和 `step`，失败时旧快照保持不变。

- [ ] **Step 4: 覆盖快照隔离**

断言提交前创建的 snapshot 不会看到后续写入；断言 append 顺序不受 Promise 完成顺序影响；断言提交失败不会部分更新。

- [ ] **Step 5: 运行状态测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/workflowState.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交独立变更**

```powershell
git add src/extension/agent/workflow/workflowState.ts src/extension/agent/workflow/dynamicGraphTypes.ts test/workflow/workflowState.test.ts
git commit -m "feat: add versioned workflow state commits"
```

### Task 4: 将动态引擎改为 superstep 运行时

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Retire after migration: `src/extension/agent/workflow/cycleManager.ts`
- Test: `test/dynamicGraphCycleIntegration.test.ts`
- Test: `test/dynamicGraphWorkflow.test.ts`

**Interfaces:**
- `DynamicGraphEngine.execute()` 继续返回最终节点结果，增加 `getStateSnapshot()` 供工具结果和事件使用。
- 节点执行内部使用 `NodeExecution { nodeId, step, attempt, status, writes }`；resolver 兼容规则只能在提交后返回新增节点配置，不能重置已完成节点。

- [ ] **Step 1: 写失败的两轮循环测试**

构造 `draft -> review` 计划：第一轮 reviewer 返回 `revise`，第二轮返回 `approve`。断言 `draft` 执行两次、`review` 执行两次、最终输出是第二轮结果。

- [ ] **Step 2: 运行循环测试确认基线失败**

Run: `npm.cmd test -- --reporter=dot test/dynamicGraphCycleIntegration.test.ts`

Expected: current `CycleManager/resetNodeForCycle` 路径无法同时满足状态历史、最终结果和步骤快照断言。

- [ ] **Step 3: 替换调度核心**

在 `execute()` 中维护 `frontier + WorkflowState`，按“snapshot -> execute -> commit -> route”循环。删除 `completedNodes.has(node.id)` 的首次写入限制；每次执行创建新的 `NodeExecution`，最终结果按最后一次成功执行回填。

- [ ] **Step 4: 处理副作用节点和预算**

将只读节点分组并发执行；检测 `role` 或工具提示为 executor 的节点时按稳定顺序串行执行。每次尝试前递增 `maxExecutions`，每个 superstep 结束后检查 `maxSteps`，超限抛出 `GraphLimitExceeded`。

- [ ] **Step 5: 处理兼容 expansionRules 并删除运行时 CycleManager 依赖**

在状态提交后执行编译图中的 `expansionRules`，将 resolver 生成节点加入下一 frontier；resolver 失败生成 `ResolverFailed` 并终止或按现有失败语义记录。新 `compiledGraph` 路径不得读取 `CycleManager` 或执行 reset；旧 `initialNodes/resolvers/cycles` 兼容路径暂保留，Task 7 必须记录其清理条件和剩余测试。

- [ ] **Step 6: 运行运行时回归测试**

Run: `npm.cmd test -- --reporter=dot test/dynamicGraphCycleIntegration.test.ts test/dynamicGraphWorkflow.test.ts test/workflowOrchestrator.test.ts`

Expected: review/fix 循环、普通 DAG、并行只读节点和失败节点行为通过。

- [ ] **Step 7: 提交独立变更**

```powershell
git add src/extension/agent/workflow/dynamicGraphEngine.ts src/extension/agent/workflow/dynamicGraphTypes.ts test/dynamicGraphCycleIntegration.test.ts test/dynamicGraphWorkflow.test.ts
git commit -m "feat: run dynamic workflows with state-driven supersteps"
```

### Task 5: 将模型工具入口切换到语义计划并保留兼容适配

**Files:**
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/extension/agent/workflow/workflowCompiler.ts`
- Test: `test/dynamicWorkflowTools.test.ts`
- Test: `test/workflow/workflowCompiler.test.ts`

**Interfaces:**
- `runDynamicGraph` 的新 schema 只暴露 `nodes/entry/initialState/maxSteps/include`。
- 旧 `initialNodes/resolvers/cycles` 仅作为兼容输入，先转换为 `expansionRules` 和编译图后执行。

- [ ] **Step 1: 写模型契约失败测试**

断言工具描述不再要求模型生成 `cycles` 或表达式；语义计划可以创建 review-fix；非法 `cycles` 输入返回带字段路径的编译错误。

- [ ] **Step 2: 运行入口测试确认基线失败**

Run: `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts`

Expected: 当前 schema 和描述仍将 `cycles` 作为推荐输入，新增断言失败。

- [ ] **Step 3: 更新工具 schema 和提示**

将 `runDynamicGraph` 的示例改成 `after/contextFrom/reviews`；明确 reviewer 必须返回 `{ decision: "approve" | "revise", feedback: string[] }`。不再向模型暴露表达式语言细节。

- [ ] **Step 4: 实现旧配置转换**

把旧 `dependsOn` 转成 `after`，把可直接映射的 `inputMapping/exportTo` 转成 `contextFrom` 和输出通道；把 `fanout/conditional/iterative` 转成受限 `expansionRules`，由同一 superstep 引擎在状态提交后处理。自由表达式和无法确定审核关系的 `cycles` 返回可读错误。

- [ ] **Step 5: 运行工具回归测试**

Run: `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts test/workflow/workflowCompiler.test.ts test/dynamicGraphWorkflow.test.ts`

Expected: 新语义计划和旧简单 DAG 通过；非法循环配置在执行前失败。

- [ ] **Step 6: 提交独立变更**

```powershell
git add src/extension/agent/dynamicWorkflowTools.ts src/extension/agent/workflow/workflowCompiler.ts test/dynamicWorkflowTools.test.ts test/workflow/workflowCompiler.test.ts
git commit -m "feat: expose semantic dynamic workflow plans"
```

### Task 6: 接入事件、结果和 Webview 最小可见状态

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/shared/messages.ts`
- Modify: `src/extension.ts`
- Modify: `src/webview/App.tsx`
- Test: `test/App.test.tsx`
- Test: `test/providerRegistryCodeContext.test.ts`

**Interfaces:**
- 新增 `StepStarted`、`StateCommitted`、`StepRouted`、`GraphLimitExceeded` 事件。
- 工具返回 `step`、`stateVersion`、`executionHistory` 和最后一次节点结果；不返回每一轮完整 prompt。

- [ ] **Step 1: 写事件协议失败测试**

断言循环一次时事件顺序为 `StepStarted -> NodeCompleted -> StateCommitted -> StepRouted`，达到上限时最后事件为 `GraphLimitExceeded` 而不是 `GraphCompleted`。

- [ ] **Step 2: 实现 host 转发**

复用现有 host message 队列，将步骤事件转换为现有 workflow progress 结构；不让 Webview 参与路由或状态提交。

- [ ] **Step 3: 更新 Webview 最小展示**

在现有 workflow 状态区域显示当前 step、节点状态、循环停止原因和最终结果。保留现有布局，不新增图编辑器。

- [ ] **Step 4: 运行 UI 和协议测试**

Run: `npm.cmd test -- --reporter=dot test/App.test.tsx test/providerRegistryCodeContext.test.ts`

Expected: 现有消息渲染和新增步骤状态断言通过。

- [ ] **Step 5: 提交独立变更**

```powershell
git add src/extension/agent/workflow/dynamicGraphTypes.ts src/extension/agent/dynamicWorkflowTools.ts src/shared/messages.ts src/extension.ts src/webview/App.tsx test/App.test.tsx test/providerRegistryCodeContext.test.ts
git commit -m "feat: expose dynamic workflow step state"
```

### Task 7: 完成纵向验收、清理和文档同步

**Files:**
- Modify: `docs/development.md`
- Modify: `docs/superpowers/INDEX.md`
- Modify: `docs/superpowers/specs/2026-07-30-bidirectional-graph-design.md`
- Modify: `docs/superpowers/plans/2026-07-31-dynamic-workflow-repair-plan.md`
- Test: `test/dynamicGraphCycleIntegration.test.ts`

- [ ] **Step 1: 运行受影响测试**

Run: `npm.cmd test -- --reporter=dot test/workflow/generatedWorkflowTypes.test.ts test/workflow/workflowCompiler.test.ts test/workflow/workflowState.test.ts test/dynamicGraphWorkflow.test.ts test/dynamicGraphCycleIntegration.test.ts test/dynamicWorkflowTools.test.ts test/App.test.tsx`

Expected: 所有状态、编译器、循环、工具入口和 UI 测试通过。

- [ ] **Step 2: 运行工程检查**

Run: `npm.cmd run typecheck`

Expected: exit code 0；如已有非本任务错误，记录文件和基线，不把它们伪装成通过。

Run: `npm.cmd run compile`

Expected: esbuild 成功生成扩展 bundle。

Run: `git diff --check`

Expected: 无空白错误。

- [ ] **Step 3: 运行真实 Extension Host 路径**

按项目规范执行 `npm run debug:vscode`，只保留一个 Extension Development Host，在同一窗口刷新后调用 `LoopAgent: Open Panel`。执行一个包含两个并行只读节点、一个 reviewer 和一次 revise 回流的 `runDynamicGraph`，确认节点时序、状态版本、停止原因和最终结果。

- [ ] **Step 4: 清理旧实现和文档**

更新开发指南，说明模型只生成语义计划；将旧的 reset-cycle 计划标记为被本计划替代；删除运行时不再引用的 `CycleManager` 导出、旧表达式提示和调试日志。不得删除用户无关的未跟踪脚本或测试。

- [ ] **Step 5: 最终审查**

检查 diff 中没有新依赖、第二套调度器、任意 `eval`、静默吞错、并行副作用执行、未接入的 schema 字段或只在单元测试中存在的假循环。

- [ ] **Step 6: 完成提交**

```powershell
git add docs/development.md docs/superpowers/INDEX.md docs/superpowers/specs/2026-07-30-bidirectional-graph-design.md docs/superpowers/plans/2026-07-31-dynamic-workflow-repair-plan.md
git commit -m "docs: finalize state-driven workflow migration"
```

## 阶段划分

### 阶段 A：核心闭环

完成 Task 1–5。交付语义计划、编译器、状态提交、superstep 运行时、弱模型校验和旧 DAG 兼容。阶段 A 结束必须能在真实 Extension Host 中运行 `review -> revise -> review -> approve`。

### 阶段 B：可见性和交付质量

完成 Task 6–7。交付步骤事件、最小 Webview 状态、完整回归和文档同步。

### 后续单独立项

持久化 checkpoint、暂停恢复、时间旅行、动态 fan-out、多副作用并发、可配置 reducer 和模型质量评分不属于本次改造，不能作为本次完成条件。

## 完成定义

只有以下条件全部满足，才可把改造标记为完成：

1. 模型输入不再要求 `cycles` 或表达式。
2. `review-fix` 循环由状态结果驱动并能执行多轮。
3. 每轮结果、状态版本和最终结果一致。
4. 单写通道冲突、非法计划、循环超限和取消都有明确失败语义。
5. 旧简单 DAG 和现有 resolver/循环调用兼容，复杂旧循环不会静默改变语义；旧路径的最终删除作为后续独立迁移门槛记录。
6. 受影响测试、类型检查、编译和真实 Extension Host 路径通过。
