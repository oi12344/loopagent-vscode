# 子代理工作流执行更正

## 目标

让主 ReAct agent 能通过受限工具创建子代理、等待结果，并将子代理执行状态回传到已有 WebView 消息流。

## 范围

- 顶层 ask ReAct runner 默认获得工作流工具；Superpowers 子代理调用 provider 时显式传入 `enableWorkflowTools: false`，不能递归获得创建、等待或取消工具。
- 子代理复用 `ReactAgentRunner` 和当前模型配置，但只接收显式只读基础工具：`exploreCode` 与已注入的 `readFile`。`applyEdit`、`runCommand`、额外工具和 ownership-bound report 工具只保留给各自父运行。
- 子代理 system prompt 只包含运行时上下文，不读取项目记忆；子代理本身不获得任何记忆工具，也从不直接写入记忆库。主运行继续负责自己的项目记忆加载和 outcome 持久化。
- **[2026-07-26 修订]** `WorkflowOrchestrator` 可选接收 `projectMemory`：子代理创建时记录当前 generation，在 `settle()` 时（`completed`/`failed`，不含 `cancelled`）代表子代理调用 `ProjectMemory.recordOutcome()`，best-effort 写入 `task_runs` 表。这是 orchestrator 宿主层的旁路记录，不经过子代理的 LLM 或工具调用，子代理的工具面和只读限制不变——隔离的是"子代理能不能主动读写记忆"，不是"子代理的执行结果最终要不要被记录"。子代理运行没有证据收集机制，`evidence` 恒为空数组，因此其产出的 `lesson` 永远是 `candidate`（未验证、30 天过期、不参与检索），不会污染主动态记忆。详见 [T11 整改](../plans/2026-07-26-dynamic-workflow-remediation-plan.md#t11-子代理经验入库路径-a-落地)。
- `WorkflowOrchestrator` 维护依赖 DAG、并发上限、超时和取消传播。
- 主代理使用 `spawnSubagent` 创建任务，使用 `waitForSubagents` 获取最终结果。
- 子代理消息继续使用既有 `workflowStateChanged`、`subagentStateChanged` 和 `agentEvent` 协议，不新增重复 WebView 消息类型。

## 取舍

- 每个主运行创建一个协调器，避免不同对话共享状态。
- 子代理不再暴露创建子代理工具；第一阶段只支持主代理调度，避免递归工具授权扩大。
- `timeoutMs` 必须为正安全整数；协调器以 `min(请求值, WorkflowLimits.subagentTimeoutMs)` 作为最终超时，模型请求不能扩大资源上限。
- `cancelSubagent` 只在待运行或运行中任务实际取消时返回成功。未知或终态 ID 返回失败，由工作流工具转成明确错误，避免模型误以为已取消。
- `waitForSubagents` 是显式等待点。模型可在同一轮并发调用多个 `spawnSubagent`，再在后续轮次汇总结果。
- 复用 provider 层已有的工具注入，不修改通用 `AgentRunner` 协议。

## 验证

- 单元测试覆盖 DAG、工具路由、依赖解锁、并发限制、失败传播、超时上限、取消真值和工具输入校验。
- 集成测试模拟主代理调用创建与等待工具，确认子代理运行结果返回主代理，并验证只读工具、记忆隔离及 Superpowers 子代理的 workflow 工具禁用。
- **[2026-07-26 新增]** 集成测试覆盖 orchestrator 层的子代理 outcome 记录：子代理成功/失败 → 真实 SQLite `task_runs` 表新增对应记录；子代理输出触发 `containsSensitiveContent` → 记录内容被 `sanitizeSummary` 脱敏；`cancelled` 结果不产生记录；未提供 `projectMemory` 时行为不变（向后兼容）。见 `test/agent/workflowOrchestratorMemory.test.ts`。
- 运行受影响测试、`npm run type-check`、`npm test`、`git diff --check`。
