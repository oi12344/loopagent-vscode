# 子代理工作流执行计划

## 成功标准

主 ReAct agent 可调用 `spawnSubagent` 创建多个独立任务或带依赖任务，并通过 `waitForSubagents` 获得子代理完成、失败或取消结果。既有 ask 模式和 WebView 消息协议保持兼容。

## 文件顺序

### Task 1: `src/extension/agent/workflow/types.ts`（已完成）

- 定义子代理状态、创建参数、结果、限制和运行器工厂接口。
- 状态与结果分离，结果只允许终态。

### Task 2: `src/extension/agent/workflow/dagValidator.ts`（已完成）

- 先在 `test/workflow/dagValidator.test.ts` 编写循环、未知依赖和深度限制的失败用例。
- 实现循环检测和最大依赖深度验证。

### Task 3: `src/extension/agent/workflow/toolRouter.ts`（已完成）

- 先在 `test/workflow/toolRouter.test.ts` 编写显式提示、高成本工具和兜底选择的失败用例。
- 根据任务文本、工具描述和显式提示选择已有工具。

### Task 4: `src/extension/agent/subagentContext.ts`（已完成）

- 在 `test/subagentContext.test.ts` 覆盖初始状态、状态转换和不可变消息追加。
- 保存单个子代理的任务、依赖、工具、运行结果和时间。

### Task 5: `src/extension/agent/workflowOrchestrator.ts`（已完成）

- 先在 `test/workflowOrchestrator.test.ts` 覆盖创建、并行启动、依赖解锁、失败取消、超时、等待和取消。
- 以注入的 `AgentRunner` 工厂启动子代理，包装其消息并维护结果承诺。

### Task 6: `src/extension/agent/workflowTools.ts`（已完成）

- 先在 `test/workflowTools.test.ts` 覆盖输入校验、创建返回 ID、等待汇总和取消。
- 实现主代理可见的 `spawnSubagent`、`waitForSubagents` 与 `cancelSubagent` 工具。

### Task 7: `src/extension/model/providerRegistry.ts`（已完成）

- 在 `test/providerRegistryCodeContext.test.ts` 增加主 ReAct 经工作流工具创建并等待子代理的集成用例。
- 每次主运行创建独立协调器；主代理收到工作流工具，子代理只收到工具路由后的原有工具。

### Task 8: 验证与记录（已完成）

- 在 `test/workflowEnd2End.test.ts` 覆盖多个创建、依赖和结果汇总。该文件放在默认发现路径，保留 `test/integration/**` 的全局排除，避免默认测试加载需要 VS Code 宿主的集成测试。
- 更新本计划的完成记录，运行受影响测试、类型检查、全量测试与 diff 检查。

### Task 9: 权限与资源边界修正（已完成）

- `providerRegistry.ts` 区分顶层工作流运行和 Superpowers 子代理运行；后者显式关闭 workflow 工具。
- 子代理只接受 `exploreCode` 与可选 `readFile`，不继承编辑、命令、额外或 ownership-bound 工具，也不加载项目记忆。
- `timeoutMs` 只接受正安全整数，协调器对请求值执行最终上限；取消工具只在真实取消时返回成功。
- 回归测试覆盖权限隔离、记忆隔离、超时上限、取消失败和异步停止路径。

## 风险控制

- 子代理只能使用显式只读基础工具，不能获得编辑、命令、额外、ownership-bound 或 workflow 调度权限。
- 父运行取消时，所有未完成子代理取消；失败依赖不会启动下游任务。
- 默认并发、总量和超时上限由 `WorkflowLimits` 控制；模型提供的超时只能缩短，不能放宽上限。

## 完成记录

- [x] 基础类型、DAG 与工具路由
- [x] 子代理上下文与调度器
- [x] 主代理工作流工具与 provider 接入
- [x] 测试、类型检查、全量验证
- [x] 权限、记忆、超时与取消边界修正

## 本次验证

- `npm test -- test/workflowEnd2End.test.ts --reporter=dot`：1 个测试通过。
- `npm run typecheck`：通过。
- `npm test -- --reporter=dot`：72 个测试文件通过，533 个测试通过，1 个跳过。
- `git diff --check`：通过。
