# 中断运行恢复设计

## 目标

用户点击 Stop 后，当前 Agent 运行保留可恢复状态；界面显示“继续执行”，用户确认后从最近一个已完成的 ReAct step 继续。已完成的对话历史仍按现有会话机制持久化。

## 范围

- 保存当前 ReAct 消息序列、下一步编号、任务、模式和更新时间。
- Stop 后保留 checkpoint，完成、失败或新建/切换会话时清理 checkpoint。
- VS Code 重启或面板重新打开后恢复中断任务提示，但不自动调用模型。
- 用户点击 Resume 后重新创建 runner，从 checkpoint 继续。
- 模型请求已发出但尚未返回时，恢复从该 step 重新请求；不尝试恢复 HTTP 请求内部状态。

## 方案

在 `ConversationStore` 增加单个会话的 interrupted-run checkpoint 存取接口。ReAct runner 在发起模型调用前、收到 assistant tool request 后、完成工具结果后保存 checkpoint。checkpoint 使用 JSON 保存完整 `ReactAgentMessage[]`，避免把 tool call/result 压扁成普通聊天消息。

`AgentRunRequest` 增加可选的通用 resume state，React runner 只消费 `kind: "react"` 的状态。扩展 Host 增加 `runInterrupted` 和 `resumeRun` 消息；Webview 显示一次 Resume 操作。父运行取消时，child 工具沿用同一个 `AbortSignal`。

## 数据一致性与失败处理

- checkpoint 按 `conversationId` 单行覆盖写，写入后再更新内存运行状态。
- 取消不会写入 assistant 完成消息；恢复成功完成后才清理 checkpoint 并写入最终 assistant 消息。
- checkpoint 损坏或版本不兼容时丢弃该 checkpoint，保留普通历史并显示可读错误。
- 同一时间只允许一个 active run；Resume 前再次取消旧句柄。

## 验证

- Agent runner：checkpoint 保存、从 checkpoint 恢复、取消后不产生完成事件。
- Conversation store：内存和 SQLite 的保存/读取/清理，以及重启后恢复。
- Extension/Webview：Stop 后出现 Resume，Resume 发起同一 conversation 的新 run。
- 命令：`npm test -- agentRunner.test.ts reactAgentRunner.test.ts extension/multiTurnConversation.integration.test.ts`、`npm run typecheck`、`npm run compile`、`git diff --check`，最后用同一个 VS Code 调试窗口验证 Stop/Resume。
