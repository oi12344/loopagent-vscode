# 动态工作流失败诊断与结果恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将动态工作流的失败处理从原样重试改为失败证据诊断、受约束修复和输出契约校验，成功恢复后只继续执行失败节点下游。

**Architecture:** 编排器把子代理消息压缩成 JSON-safe 诊断日志；引擎在节点失败后通过注入的恢复回调取得 `RecoveryPlan`，在同一节点上执行修复任务并验证输出；已完成上游结果和 checkpoint 保持不变。`workflowRecovery.ts` 继续作为确定性分类与恢复计划校验边界，不直接调用模型。

**Tech Stack:** TypeScript、Vitest、现有 `WorkflowOrchestrator`、`runDynamicGraph`、SQLite checkpoint、VS Code CDP。

---

### Task 1: 补充失败证据与输出契约类型

**Files:**
- Modify: `src/extension/agent/workflow/types.ts`
- Modify: `src/extension/agent/workflow/dynamicGraphTypes.ts`
- Modify: `src/shared/workflowCheckpoint.ts`
- Test: `test/dynamicGraphWorkflow.test.ts`
- Test: `test/extension/conversation/workflowCheckpoint.test.ts`

- [ ] **Step 1: Write the failing tests**

增加断言：失败结果能携带受限 `diagnosticLog`；节点可声明 `outputContract.requiredText/requiredFields/minLength`；checkpoint 能保存诊断摘要和恢复状态。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/extension/conversation/workflowCheckpoint.test.ts`

Expected: TypeScript/test failure，提示字段不存在。

- [ ] **Step 3: Implement the minimal types and sanitizer**

新增 `SubagentDiagnosticLog`、`WorkflowOutputContract`、`WorkflowFailureEvidence`；只允许字符串、数字、数组和小对象，限制每条日志和总大小；把 checkpoint 的 `unresolvedFailures` 扩展为可选诊断字段，保持旧数据兼容。

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/extension/conversation/workflowCheckpoint.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/extension/agent/workflow/types.ts src/extension/agent/workflow/dynamicGraphTypes.ts src/shared/workflowCheckpoint.ts test/dynamicGraphWorkflow.test.ts test/extension/conversation/workflowCheckpoint.test.ts
git commit -m "feat: add workflow failure evidence contract"
```

### Task 2: 从编排器输出诊断日志

**Files:**
- Modify: `src/extension/agent/workflowOrchestrator.ts:40-190`
- Modify: `src/extension/agent/subagentContext.ts` only if snapshot typing requires it
- Test: `test/workflow/workflowOrchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

让 fake runner 发出 assistant、tool result 和 `runFailed` 消息；断言 `waitForSubagents` 的失败结果包含脱敏、截断后的诊断日志，且不包含疑似 key/token。

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run test/workflow/workflowOrchestrator.test.ts`

Expected: FAIL because `diagnosticLog` is missing.

- [ ] **Step 3: Implement minimal log summarization**

在 `settle` 前从 `entry.messages` 提取消息类型、工具名、状态和有限文本；对 `sk-`、Bearer token、长参数和二进制内容做替换/截断；失败结果携带摘要，成功结果不扩大现有返回体。

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run test/workflow/workflowOrchestrator.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/extension/agent/workflowOrchestrator.ts test/workflow/workflowOrchestrator.test.ts
git commit -m "feat: expose sanitized subagent diagnostics"
```

### Task 3: 校验节点输出契约

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Test: `test/dynamicGraphWorkflow.test.ts`
- Test: `test/dynamicWorkflowTools.test.ts`

- [ ] **Step 1: Write the failing tests**

覆盖：满足 `requiredText` 才完成；JSON `requiredFields` 缺失变成 `contract` 失败；`summary` 不消费失败节点结果。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts`

Expected: FAIL because all non-error subagent content is currently accepted as completed.

- [ ] **Step 3: Implement the validator**

在引擎收到 `completed` 结果后先执行最小契约校验；失败时构造 `contract` 错误并走统一失败路径，不写 `globalData`，不触发成功下游。

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/extension/agent/workflow/dynamicGraphEngine.ts src/extension/agent/dynamicWorkflowTools.ts test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts
git commit -m "fix: gate workflow nodes on output contracts"
```

### Task 4: 接入诊断与修复回调

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Modify: `src/extension/agent/workflow/workflowRecovery.ts` only for shared evidence/action helpers
- Test: `test/dynamicGraphWorkflow.test.ts`
- Test: `test/dynamicWorkflowTools.test.ts`

- [ ] **Step 1: Write the failing tests**

用 fake diagnostic callback：A 成功、B 第一次失败；诊断返回 `replace_node` 和修复任务；B 第二次成功；断言 A 只调用一次、B 输出进入 `exportTo`、C 只在 B 合法完成后执行。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts`

Expected: FAIL because the engine has no diagnostic callback and leaves B failed.

- [ ] **Step 3: Implement bounded recovery**

给引擎注入 `diagnoseFailure` 回调；每个节点保留恢复次数和失败指纹。失败后先回调诊断器，按 `parseRecoveryPlan` 约束动作；只对 `none` 副作用执行修复任务；修复成功后覆盖原结果并重新调度下游；预算耗尽或副作用不确定时进入 `recovery_required`。

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/extension/agent/workflow/dynamicGraphEngine.ts src/extension/agent/dynamicWorkflowTools.ts src/extension/agent/workflow/workflowRecovery.ts test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts
git commit -m "feat: diagnose and repair failed workflow nodes"
```

### Task 5: 持久化恢复证据与防止恢复预算突破

**Files:**
- Modify: `src/extension/agent/workflow/dynamicGraphEngine.ts`
- Modify: `src/extension/agent/dynamicWorkflowTools.ts`
- Test: `test/dynamicGraphWorkflow.test.ts`
- Test: `test/extension/conversation/persistentConversationStore.test.ts`

- [ ] **Step 1: Write the failing tests**

断言恢复后 attempts 使用累计预算，不会从 `attempts=2` 再执行两个完整批次；断言每次失败证据和诊断状态写入 checkpoint，旧运行不能覆盖新运行。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/extension/conversation/persistentConversationStore.test.ts`

Expected: FAIL because restore currently resets a failed node to pending while reusing the full retry budget and only final results are persisted.

- [ ] **Step 3: Implement cumulative recovery budget and checkpoint writes**

将剩余尝试计算为 `maxAttempts - attempts`；每次失败和进入 diagnosing/repairing/validating 时递增 checkpoint revision；resume 只执行剩余预算，并保留诊断历史。

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/extension/conversation/persistentConversationStore.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/extension/agent/workflow/dynamicGraphEngine.ts src/extension/agent/dynamicWorkflowTools.ts test/dynamicGraphWorkflow.test.ts test/extension/conversation/persistentConversationStore.test.ts
git commit -m "fix: preserve recovery budget across resumes"
```

### Task 6: CDP 多步骤诊断恢复验收

**Files:**
- Create: `scripts/test-workflow-diagnosis-recovery-cdp.mjs`
- Modify: `docs/superpowers/plans/2026-08-01-workflow-failure-diagnosis-recovery-plan.md`
- Create: `docs/superpowers/plans/2026-08-01-workflow-failure-diagnosis-recovery-verification.md`

- [ ] **Step 1: Add the real scenario**

构造 `prepare -> analysis-a/analysis-b -> flaky-check -> summary`，让 `flaky-check` 首次失败，诊断返回修复任务，修复结果满足 `requiredText`，验证 `summary` 消费修复后的结果。

- [ ] **Step 2: Run the CDP scenario**

Run: `npm run compile` then `npm run debug:vscode` and `node scripts/test-workflow-diagnosis-recovery-cdp.mjs`。

Expected: `workflowStatus: completed`，失败日志和诊断原因可见，`prepare`/分析节点各执行一次，修复节点执行两次，`summary` 只执行一次。

- [ ] **Step 3: Run final gates**

Run in parallel: `npm test -- --run test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts test/workflow/workflowOrchestrator.test.ts test/extension/conversation/workflowCheckpoint.test.ts`, `npm run compile`, `git diff --check`。

Expected: focused tests and compile pass；全量基线失败单独记录，不修改无关模块。

- [ ] **Step 4: Commit docs and CDP script**

```powershell
git add scripts/test-workflow-diagnosis-recovery-cdp.mjs docs/superpowers/plans/2026-08-01-workflow-failure-diagnosis-recovery-plan.md docs/superpowers/plans/2026-08-01-workflow-failure-diagnosis-recovery-verification.md
git commit -m "test: verify workflow diagnosis recovery with cdp"
```
