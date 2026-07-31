# 工作流正确性与死代码清理修复 实施计划

关联设计：`docs/superpowers/specs/2026-07-31-workflow-review-fixes-design.md`

## 任务拆解

### Task 1：修复 review 路由死循环（正确性）

- [x] `dynamicGraphEngine.ts` 的 `getReviewDecision`：无法解析时返回 `undefined`（删除末尾 `return "revise"`）。
- [x] 新增 `test/workflow/reviewDecisionFallback.test.ts`：review 输出非法 JSON 且不含 `APPROVED` → 断言不触发 revise 回退、图正常结束、`finalNodes` 含该 review。

### Task 2：修复 cycleState 死代码（正确性）

- [x] `cycleManager.ts:246-260`：从表达式上下文移除 `cycleState` 字段。
- [x] `cycleManager.ts:275-280` 的 `catch`：日志提示改用 cost-limit/time-limit 或纯节点引用表达式。
- [x] 新增测试：含 cycleState 的 breakWhen 表达式优雅失败（记录原因、不静默触发）。

### Task 3：删除死代码 toolDispatcher

- [x] 删除 `src/extension/agent/toolDispatcher.ts`。
- [x] 删除 `test/toolDispatcher.test.ts`。
- [x] `npm run typecheck` 确认无残留引用。

### Task 4：清理 dead config maxConcurrentExecutions

- [x] `generatedWorkflowTypes.ts`：删除字段声明。
- [x] `workflowCompiler.ts`：删除默认值常量与传递。

### Task 5：集中验证

- [x] `npm run typecheck`：47 个错误，无一落在工作流改动上。`codeReviewTool.ts`、`javaAdapter.ts`、`javaAstExtractor.ts` 为尚未提交 git 的新增文件；`App.tsx` 相对 HEAD 零改动，报错源于 `codeReviewTool.ts` 配套类型未加进 `chatTypes.ts`。
- [x] `npm test`（全量）：89 个文件、744 个用例，5 个失败全部为既有问题（`App.test.tsx` 2、`codeReviewTool` 2、`exploreCodeSpool` 1），与工作流无关。
- [x] `git diff --check`。

## 验收步骤

1. `getReviewDecision` 返回类型保持 `"approve" | "revise" | undefined`，无法解析时返回 `undefined`。
2. review 路由在决策未知时不再回退被审节点，图自然收敛。
3. `cycleManager` 表达式上下文不再注入 `cycleState`；含其的表达式走 `catch` 并打印改进日志。
4. `toolDispatcher.ts` 与其测试被删除，typecheck 通过。
5. `maxConcurrentExecutions` 从类型与 compiler 中消失，typecheck 通过。
6. 全量 `npm test` 通过。

## 完成记录

- Task 1：`dynamicGraphEngine.ts` 的 `getReviewDecision` 在无法解析时返回 `undefined`；新增 `test/workflow/reviewDecisionFallback.test.ts`，覆盖未知决策不回退与合法 `revise` 回归。
- Task 2：`cycleManager.ts` 的表达式上下文仅传递已完成节点结果和 `globalData`，不再注入 `cycleState`；不支持的表达式记录替代方案日志；新增 `test/workflow/cycleStateExpressionFallback.test.ts`。
- Task 3：删除 `src/extension/agent/toolDispatcher.ts` 与 `test/toolDispatcher.test.ts`，并确认 `src`、`test` 无残留引用。
- Task 4：从 `generatedWorkflowTypes.ts` 与 `workflowCompiler.ts` 移除 `maxConcurrentExecutions`。
- 定向验证：`npm.cmd test -- --run test/workflow/reviewDecisionFallback.test.ts test/workflow/cycleStateExpressionFallback.test.ts test/workflow/workflowCompiler.test.ts test/workflow/superstepGraphEngine.test.ts`，4 个文件、12 个测试通过；`npm.cmd run compile` 通过。
- 类型检查：`npm.cmd run typecheck` 已无本次工作流改动相关错误，但被工作区既有的 `codeReviewTool.ts`、Java 语言适配器和 Webview 类型错误阻塞。
- 全量测试：`npm.cmd test -- --reporter=dot --maxWorkers=1` 在 `test/visionIntegration.test.ts` 启动 Python 视觉服务时因 `spawn python EACCES` 超时；排除该测试的全量命令仍受现有外部测试进程阻塞，未据此修改业务代码。
