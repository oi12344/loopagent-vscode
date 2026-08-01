# 动态工作流失败诊断与结果恢复实施计划

## 目标

将动态工作流从“失败后原样重试或回退重跑”改为：

```text
节点失败 -> 保存失败证据 -> 诊断原因 -> 生成受约束修复任务
       -> 校验修复输出契约 -> 只继续当前节点的下游
```

已完成的结果必须保持不变；副作用不确定或恢复预算耗尽时，工作流进入 `recovery_required`，不能伪装成成功。

## 实现范围

### 1. 失败证据与输出契约

- 在 `workflowCheckpoint.ts` 增加受限的诊断日志、失败输入、尝试次数、实际超时和副作用字段，并保持旧 checkpoint 可读取。
- 在 `dynamicGraphTypes.ts`、`generatedWorkflowTypes.ts` 增加严格 `exactText`、`requiredText`、`requiredFields`、`minLength` 和节点 `timeoutMs`。
- 对恢复计划的 `timeoutMs` 使用安全整数和上限校验，防止模型扩大执行预算。

### 2. 编排器诊断日志

- `workflowOrchestrator.ts` 从失败子代理消息生成有界摘要。
- 对 key、Bearer token、密码等敏感值统一脱敏；成功结果不额外扩大返回体。

### 3. 引擎恢复流程

- `dynamicGraphEngine.ts` 在发布结果前校验输出契约。
- 安装诊断回调后，失败节点不再执行盲重试；诊断器返回 `RecoveryPlan` 后，只在失败节点上执行受约束修复任务。
- 恢复计划的超时覆盖只作用于当前修复尝试，并写入 checkpoint；恢复次数使用累计预算。
- 修复成功才覆盖原结果并放行下游，已完成上游不会被重新调度。
- 可执行恢复计划先持久化为 `pendingRecovery`；恢复进程直接续跑修复任务，不重新执行原失败任务。
- 缺少子代理结果、契约不满足、未知副作用和预算耗尽均走统一失败/恢复状态。

### 4. 工具层接入

- `dynamicWorkflowTools.ts` 把失败证据交给诊断子代理，严格解析 JSON 并再次通过 `parseRecoveryPlan` 校验。
- 将诊断模型返回的 `retry + 非空 task` 归一化为 `replace_node` 后再校验，避免动作标签与修复内容不一致时丢弃可执行方案。
- 限制诊断响应长度，脱敏恢复原因，返回 `recoveryDiagnostics`、`unresolvedFailures` 和最终状态。
- checkpoint 持久化动态节点定义、恢复诊断历史和待执行恢复计划，对大结果做有界脱敏；显式校验 `resumeToken`，新 run 通过原子 claim 接管同一对话的旧 checkpoint，终态 owner 栅栏拒绝完成后的迟到写入。

## 验证任务

- [x] 类型、checkpoint、输出契约和恢复计划的单元测试。
- [x] 编排器日志脱敏、截断和失败结果测试。
- [x] 首次失败、诊断、替换修复、契约校验、累计预算和 resume 测试。
- [x] `npm run compile` 通过。
- [x] 定向 Vitest：7 个文件、217 个测试通过，覆盖恢复、checkpoint 所有权、恢复计划续跑和 `retry + task` 归一化。
- [x] 真实 VS Code Webview/CDP 多步骤场景通过，验证并行上游不重跑。
- [x] 更新 CDP 验收记录：`docs/superpowers/plans/2026-08-01-workflow-failure-diagnosis-recovery-cdp-verification.md`。

## 最终验收命令

```powershell
npm run compile
npm test -- --run test/workflow/workflowRecovery.test.ts test/workflow/generatedWorkflowTypes.test.ts test/dynamicGraphWorkflow.test.ts test/dynamicWorkflowTools.test.ts test/extension/conversation/workflowCheckpoint.test.ts test/extension/conversation/persistentConversationStore.test.ts
node --check scripts/test-failure-diagnosis-recovery-cdp.mjs
node scripts/test-failure-diagnosis-recovery-cdp.mjs --dry-run
node scripts/test-failure-diagnosis-recovery-cdp.mjs
git diff --check
```

## 风险与边界

- `npm run typecheck` 的全量基线仍有其他模块既有错误；本次改动相关源码由 `npm run compile` 和定向测试覆盖。
- CDP 场景验证了超时失败和无副作用替换；真实外部副作用的补偿需要具体工具提供幂等键或回滚契约，不能由通用引擎猜测。
