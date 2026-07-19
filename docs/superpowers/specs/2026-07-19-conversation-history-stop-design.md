# 会话历史与停止生成设计

> 状态：已批准并进入收尾实现
>
> 前置设计：`docs/superpowers/specs/2026-07-19-conversation-persistence-design.md`

## 目标

在现有多轮对话持久化上补齐一个最小可用闭环：旧对话在创建新对话后继续保留；用户可从 History 列表切换；运行中可点击 Stop，且停止后不会继续启动、执行工具或更新当前界面。

## 用户路径

1. 用户完成一轮对话，点击 New chat 后发送另一条消息。
2. History 同时显示新旧对话，按最后更新时间倒序排列。
3. 用户选择旧对话，界面恢复完整消息；下一条消息继续该对话。
4. 用户在 runner 创建中或流式生成中点击 Stop，host 取消该轮，webview 忽略迟到消息。
5. 重开面板或重启 VS Code 后，最后选中的对话自动恢复，历史列表仍可切换。

## 数据与消息

- `conversation` 表按 `conversation_id` 保留多行，不拆消息关系表；每行仍以 `messages_json` 保存完整历史。
- `active_conversation` 单行表只保存当前对话指针。New chat 清空指针，不删除历史行。
- 仓库根 `.gitignore` 忽略 `.loopagent/`，本地索引和对话数据库不进入 Git 状态。
- host 通过 `conversationList` 推送摘要，通过 `conversationRestored` 恢复选中对话。
- webview 在提交时生成 runId，并随 `startTask`/`continueConversation` 发送；host 必须用同一个 ID 启动轮次。
- webview 通过 `switchConversation` 切换，通过 `stopRun` 停止当前轮次。

## 关键正确性

- 切换对话、New chat、Stop 和销毁面板都必须取消当前轮次。
- 取消必须覆盖 `createConfiguredAgentRunner()` 尚未完成的阶段；被取消的 runner Promise 即使随后完成，也不得调用 `runner.run()`。
- webview 从点击 Send 起就持有 runId；Stop 在收到 `runStarted` 前也能忽略该 run 的迟到消息。
- webview 在本地立即结束运行态，保留已有部分内容，并删除无内容的助手占位。
- 损坏的单条历史记录只丢失该条预览，不阻断其余历史列表。

## 非目标

- 不做会话删除、重命名、搜索、导出或分页。
- 不做多窗口 writer lease；仍采用 SQLite busy timeout 和最后写入者胜出。
- 不重构 ReAct 工具循环，不接入当前无调用方的 `ModelRunner`。
- 不改编辑预览命令或预览交互。

## 验证

```powershell
npm test -- agentRunner.test.ts App.test.tsx conversationManager.test.ts conversationStore.test.ts persistentConversationStore.test.ts
npm test
npm run typecheck
npm run compile
git diff --check
npm run debug:vscode
```

真实调试窗口验证：两次对话、History 切回、继续追问、构造期 Stop、流式期 Stop、重开面板恢复。
