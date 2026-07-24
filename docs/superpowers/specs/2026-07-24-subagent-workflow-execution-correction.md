# 子代理工作流执行更正

## 目标

让主 ReAct agent 能通过受限工具创建子代理、等待结果，并将子代理执行状态回传到已有 WebView 消息流。

## 范围

- 子代理复用 `ReactAgentRunner`、当前模型配置和现有工具。
- `WorkflowOrchestrator` 维护依赖 DAG、并发上限、超时和取消传播。
- 主代理使用 `spawnSubagent` 创建任务，使用 `waitForSubagents` 获取最终结果。
- 子代理消息继续使用既有 `workflowStateChanged`、`subagentStateChanged` 和 `agentEvent` 协议，不新增重复 WebView 消息类型。

## 取舍

- 每个主运行创建一个协调器，避免不同对话共享状态。
- 子代理不再暴露创建子代理工具；第一阶段只支持主代理调度，避免递归工具授权扩大。
- `waitForSubagents` 是显式等待点。模型可在同一轮并发调用多个 `spawnSubagent`，再在后续轮次汇总结果。
- 复用 provider 层已有的工具注入，不修改通用 `AgentRunner` 协议。

## 验证

- 单元测试覆盖 DAG、工具路由、依赖解锁、并发限制、失败传播和工具输入校验。
- 集成测试模拟主代理调用创建与等待工具，确认子代理运行结果返回主代理。
- 运行受影响测试、`npm run type-check`、`npm test`、`git diff --check`。
