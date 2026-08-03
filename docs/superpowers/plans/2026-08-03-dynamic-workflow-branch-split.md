# 动态工作流分支拆分计划

## 目标

将动态图运行时从 `main` 移到 `codex/dynamic-workflow`，让主分支只保留普通子智能体编排能力。

## 主分支保留

- `WorkflowOrchestrator` 的子智能体生命周期、依赖调度、并发限制、角色和工具路由。
- `spawnSubagent`、`waitForSubagents`、`cancelSubagent` 工具及其事件展示。
- 普通 React Agent 的会话中断恢复。

## 主分支移除

- `runDynamicGraph` 入口及动态节点、resolver、cycle、状态通道和数据流运行时。
- 动态工作流专属 checkpoint、失败恢复和动态图验证测试。
- 主 Agent 对动态图工具的提示、依赖注入和动态图状态消息。

## 验证

- `npm run typecheck`
- `npm run compile`
- 受影响的子智能体与会话测试
- `npm test -- --reporter=dot --maxWorkers=1`
- `git diff --check`

动态图源码、设计文档和历史验证材料保留在 `codex/dynamic-workflow` 分支。
