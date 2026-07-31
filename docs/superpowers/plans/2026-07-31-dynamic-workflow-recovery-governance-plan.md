# 动态工作流全错误恢复与计划治理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个节点错误都进入可验证、可恢复、可恢复执行的解决流程，同时消除结果缺失、伪成功和弱模型计划粒度失控。

**Architecture:** 模型生成的语义计划先经过宿主策略和编译器校验。运行时将成功输出、失败记录、恢复动作和 checkpoint 原子提交到版本化状态，由系统 `RecoverySupervisor` 驱动诊断、重试、重规划、替代、对账、补偿或等待外部条件。工作流只有在所有必需节点产出通过验证且无未解决错误时才能 `completed`。

**Tech Stack:** TypeScript、Vitest、现有 `WorkflowOrchestrator`、`DynamicGraphEngine`、VS Code `workspaceState`、Webview、CDP；不增加第三方策略或工作流依赖。

## Global Constraints

- 直接在当前 checkout 开发，保留用户已有改动，不创建 worktree。
- 所有错误都必须进入恢复流程；自动恢复耗尽后进入 `waiting_input` 或 `waiting_external`，不得丢失状态或伪装完成。
- 只有用户明确取消才进入 `cancelled`；运行时不得因普通节点错误直接结束整个 run。
- 所有恢复动作受 `maxSteps/maxExecutions/maxRecoveryAttempts` 限制，达到上限后持久化等待，不得无限循环。
- 副作用结果不确定时先对账，禁止盲目重试；需要破坏性补偿或重复写入时必须获得确认。
- 新语义路径不得使用 `CycleManager/resetNodeForCycle/pending-retry` 表达恢复。
- 策略由宿主注入，模型不得降低硬限制或生成自由表达式、任意循环和任意 fan-out。
- 文档和验证记录使用中文；代码标识符、命令和错误原文保留英文。

## 文件边界

- `dynamicGraphTypes.ts`：运行状态、失败、恢复动作、checkpoint 和事件类型。
- `generatedWorkflowTypes.ts`、`workflowCompiler.ts`：语义节点和恢复路由编译。
- `workflowState.ts`：成功、错误、恢复历史的原子提交。
- `workflowRecovery.ts`：错误分类、`RecoveryPlan` 解析和确定性校验。
- `workflowCheckpointStore.ts`：基于 `workspaceState` 的保存、读取和删除。
- `workflowPlanPolicy.ts`：宿主控制的计划粒度策略。
- `dynamicGraphEngine.ts`：RecoverySupervisor、恢复执行和继续调度。
- `dynamicWorkflowTools.ts`、`reactAgentRunner.ts`：运行/恢复入口和完成门禁。
- `messages.ts`、`App.tsx`：等待、恢复和完成状态展示。
- `run-complex-multi-file-test.mjs`、`run-workflow-recovery-e2e.mjs`：真实 CDP 验收。

### Task 1: 固化运行状态和错误证据契约

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Modify: `src/extension/agent/workflow/generatedWorkflowTypes.ts`
- Test: `test/workflow/superstepGraphEngine.test.ts`

**Produces:** `WorkflowRunStatus`、`WorkflowFailure`、`DynamicGraphRunResult`。

- [ ] 写失败测试：一个节点失败时错误、输入通道、步骤和尝试次数都存在，图不能 `completed`。

```ts
export type WorkflowRunStatus =
  | "running" | "recovering" | "waiting_input" | "waiting_external"
  | "completed" | "cancelled";
export type WorkflowFailure = {
  nodeId: string; category: FailureCategory; error: string;
  step: number; attempt: number; inputChannels: string[]; fingerprint: string;
};
```

- [ ] 运行 `npm.cmd test -- --reporter=dot test/workflow/superstepGraphEngine.test.ts`，确认当前因失败结果缺失而 FAIL。
- [ ] 将 `execute()` 返回值改为 `DynamicGraphRunResult`，其中包含 `results`、`unresolvedFailures`、`unreachedNodes`、`recoveryAttempts` 和 `checkpointId`。
- [ ] 重跑测试，Expected: PASS；提交 `refactor: define recoverable workflow result contract`。

### Task 2: 保存失败结果并阻断伪成功

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/workflow/workflowState.ts`
- Modify: `test/workflow/workflowState.test.ts`
- Modify: `test/workflow/superstepGraphEngine.test.ts`

**Produces:** `errors.<nodeId>`、失败 `history` 和准确的未到达节点。

- [ ] 增加测试：失败结果仍进入 `results`，错误写入 `errors.analyze`，但不写 `outputs.analyze`。
- [ ] 删除编译路径中硬编码的空 `failedNodes/unreachedNodes`；从节点状态计算未解决错误和受阻依赖。
- [ ] frontier 为空但存在未解决错误时进入 `recovering`，不能发出完成事件。
- [ ] 运行 `npm.cmd test -- --reporter=dot test/workflow/workflowState.test.ts test/workflow/superstepGraphEngine.test.ts test/dynamicGraphWorkflow.test.ts`，Expected: PASS；提交 `fix: preserve workflow error evidence`。

### Task 3: 建立错误分类和恢复动作契约

**Files:**
- Create: `src/extension/agent/workflow/workflowRecovery.ts`
- Create: `test/workflow/workflowRecovery.test.ts`
- Modify: `src/extension/agent/workflow/generatedWorkflowTypes.ts`
- Modify: `src/extension/agent/workflow/workflowCompiler.ts`

**Produces:** `FailureCategory`、`RecoveryAction`、`RecoveryPlan`、`parseRecoveryPlan()`。

- [x] 用表驱动测试覆盖 transient、planning、context、tool、provider、side-effect-uncertain、external、unknown。

```ts
export type RecoveryAction =
  | "retry" | "replan" | "replace_node" | "replace_tool" | "switch_provider"
  | "reconcile_side_effect" | "compensate" | "request_input" | "wait_external";
export type RecoveryPlan = {
  action: RecoveryAction; targetNodeId: string; reason: string;
  task?: string; role?: SubagentRoleId; contextFrom?: string[];
};
```

- [x] `parseRecoveryPlan()` 拒绝未知字段、未知节点、自由表达式、任意 fan-out 和超过长度的任务。
- [x] 编译器为所有节点生成错误通道；副作用角色只能选择对账、补偿或请求确认。
- [x] 运行 `npm.cmd test -- --reporter=dot test/workflow/workflowRecovery.test.ts test/workflow/workflowCompiler.test.ts`，Expected: PASS（118 passed）。

**实际落地与计划的偏差（Task 3）：**

1. **没有发"RecoverySupervisor 路由"。** 原计划让编译器为每个节点生成一条恢复边。`dynamicGraphEngine.ts`
   的 `isActivated()` 要求某节点的**全部**入边都已激活才判定可达，所以往真实节点上加恢复边会直接把
   它变成永不可达——恢复机制会先把正常执行打挂。而且"每个节点都有一条恢复边"与节点列表本身信息等价，
   Task 4 的 Supervisor 直接读 `CompiledWorkflowNode.recoveryActions` 即可，不需要这层重复表达。
   改为把恢复元数据放在节点上：`errorChannel`、`hasSideEffect`、`recoveryActions`。
2. **`errors.<nodeId>` 用 append 而非 single。** 失败节点会被恢复流程重跑，single 模式会让前几次的
   失败证据被覆盖，而"同一个错误重复出现"恰恰是 Supervisor 判断该换动作的依据。
3. **副作用节点的动作集额外含 `wait_external`。** 测试发现原定的三选一（对账/补偿/请求确认）会让
   预算耗尽的副作用节点一个合法动作都没有——运行时在上限处只发 `request_input/wait_external`，
   上界少了后者就会把它挡掉，"达到上限后持久化等待"被上界自己否决。
4. **`allowedRecoveryActions` 对副作用节点忽略错误分类。** 不只是去掉 `retry`：`replace_node` 同样
   被排除，因为替代节点执行的是同一件写操作，换个 id 不会让重复写入变安全。
5. **未改 `generatedWorkflowTypes.ts` 的解析入口。** 恢复动作不由模型在计划阶段声明，而是运行时
   按真实错误分类协商，所以 `GeneratedWorkflowNode` 无需新字段；改动只在 `CompiledWorkflowNode`。

### Task 4: 实现 RecoverySupervisor 自动解决链

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `test/workflow/superstepGraphEngine.test.ts`

**Consumes:** `RecoveryPlan`、`maxRecoveryAttempts`；**Produces:** `RecoveryPlanned/RecoveryVerified/RecoveryWaiting` 事件。

- [ ] 增加闭环测试：只读节点第一次失败，Supervisor 补充上下文并创建替代节点，验证产出后继续原后继。
- [ ] 实现固定阶段：`classify -> plan -> execute -> verify`；失败后必须换动作，禁止相同 fingerprint 和动作无限重复。
- [ ] `replace_node` 创建 `<target>__recovery_<attempt>`，成功后发布到原目标输出通道，保持下游契约不变。
- [ ] `retry/replan/replace` 失败或达到上限后选择 `request_input/wait_external`，不得进入普通终止态。
- [ ] 运行 `npm.cmd test -- --reporter=dot test/workflow/superstepGraphEngine.test.ts test/dynamicWorkflowTools.test.ts`，Expected: PASS；提交 `feat: resolve node errors through recovery supervisor`。

### Task 5: 对账和补偿副作用

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/editPreviewService.ts`
- Modify: `src/extension/agent/runCommandTool.ts`
- Test: `test/workflow/superstepGraphEngine.test.ts`
- Test: `test/editTools.test.ts`

- [ ] 增加测试：写文件后响应丢失时先比较实际文件内容，不重复应用相同修改。
- [ ] 为编辑和命令结果生成可比较的 `operationId`、目标摘要和结果证据；未知副作用进入 `reconcile_side_effect`。
- [ ] 已成功则补记完成；未发生则允许重试；部分发生则生成补偿方案并请求确认。
- [ ] 运行 `npm.cmd test -- --reporter=dot test/editTools.test.ts test/workflow/superstepGraphEngine.test.ts`，Expected: PASS；提交 `feat: reconcile uncertain workflow side effects`。

### Task 6: 持久化等待和恢复执行

**Files:**
- Create: `src/extension/agent/workflow/workflowCheckpointStore.ts`
- Create: `test/workflow/workflowCheckpointStore.test.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `test/dynamicWorkflowTools.test.ts`

**Produces:** `saveCheckpoint()`、`loadCheckpoint()`、`resumeRun()`。

- [ ] 用内存 `Memento` 测试 checkpoint 的版本、状态、frontier、错误、恢复历史和策略预算 round-trip。
- [ ] `waiting_input/waiting_external` 前必须保存 checkpoint；恢复时校验版本和工作区标识，拒绝过期或跨工作区状态。
- [ ] 在同一 `runDynamicGraph` 工具增加互斥输入 `resume: { runId, resolution }`，模型不能改写原图硬限制。
- [ ] 恢复成功并完成后删除 checkpoint；用户取消时保留诊断摘要但删除可执行状态。
- [ ] 运行 `npm.cmd test -- --reporter=dot test/workflow/workflowCheckpointStore.test.ts test/dynamicWorkflowTools.test.ts`，Expected: PASS；提交 `feat: resume waiting workflows from checkpoints`。

### Task 7: 修复工具和父智能体完成门禁

**Files:**
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/extension/agent/reactAgentRunner.ts`
- Modify: `test/dynamicWorkflowTools.test.ts`
- Modify: `test/reactAgentRunner.test.ts`

- [ ] 增加测试：`recovering/waiting_*` 不计入成功工具集合，模型输出“Done”时 runner 继续要求恢复或请求用户输入。
- [ ] 工具结果固定返回 `workflowStatus/unresolvedFailures/waitReason/checkpointId/recoveryAttempts`。
- [ ] 只有 `workflowStatus === "completed"` 且 `unresolvedFailures.length === 0` 才满足 `runDynamicGraph` 完成门禁。
- [ ] 运行 `npm.cmd test -- --reporter=dot test/dynamicWorkflowTools.test.ts test/reactAgentRunner.test.ts`，Expected: PASS；提交 `fix: gate completion on resolved workflow state`。

### Task 8: 增加宿主计划粒度策略

**Files:**
- Create: `src/extension/agent/workflow/workflowPlanPolicy.ts`
- Create: `test/workflow/workflowPlanPolicy.test.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`

- [ ] 定义宿主固定策略：`balanced = { maxNodes: 16, maxFanOut: 6, maxTaskChars: 800, maxRecoveryAttempts: 2 }`。
- [ ] 测试节点超限、fan-out 超限、任务过长、缺少聚合节点和模型试图降低硬限制，返回 `allow/replan/reject` 及精确 path。
- [ ] 接入顺序固定为 `parse -> evaluatePlanPolicy -> compile`；`replan` 一次后仍不合格则进入 `waiting_input`，不执行坏计划。
- [ ] 运行 `npm.cmd test -- --reporter=dot test/workflow/workflowPlanPolicy.test.ts test/dynamicWorkflowTools.test.ts`，Expected: PASS；提交 `feat: enforce host workflow planning policy`。

### Task 9: Webview、CDP、文档和最终验证

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/webview/App.tsx`
- Modify: `test/App.test.tsx`
- Modify: `scripts/run-complex-multi-file-test.mjs`
- Create: `scripts/run-workflow-recovery-e2e.mjs`
- Modify: `docs/superpowers/specs/2026-07-31-state-driven-dynamic-workflow-design.md`
- Modify: `docs/development.md`

- [ ] Webview 测试覆盖 `Recovering`、`Waiting for input`、`Waiting for external condition`、`Completed`；显示失败节点、动作和 checkpoint，不把 `Ready` 当工作流成功。
- [ ] 修复现有 CDP 脚本：以新助手消息、执行计划终态和结构化 `workflowStatus` 判断完成，删除只识别 `Completed/Error` 的逻辑。
- [ ] 新 CDP 场景验证：未知文件失败、自动替代完成；缺少凭据进入等待、提供 resolution 后从 checkpoint 完成；副作用响应丢失后对账且不重复写入。
- [ ] 运行受影响测试、`npm.cmd run compile`、`npm.cmd run typecheck`、全量 `npm.cmd test -- --reporter=dot` 和 `git diff --check`。
- [ ] 更新架构规格和开发规范，记录旧路径任何错误也必须进入等待/恢复契约；提交 `docs: complete workflow recovery governance`。

## 整体验收标准

1. 每个节点错误都有证据、分类、恢复动作和验证结果。
2. 自动恢复未解决时进入持久化等待，重新提供条件后能从 checkpoint 继续。
3. 副作用不确定时不会盲目重试，必须对账、补偿或请求确认。
4. 所有必需节点通过验证且没有未解决错误时才允许 `completed`。
5. 弱模型不能绕过策略、编译器、恢复预算和完成门禁。
6. CDP 真实流程覆盖自动恢复、等待后恢复和副作用对账三条路径。
