# 用户消息重复显示修复设计

## 背景

Webview 提交消息时会先插入一条 `pending` 用户消息。新会话随后依次收到 `conversationStarted` 和 Agent 发出的 `runStarted`，两个事件都会调用 `attachRunToUserTurn()`。第一次绑定会清除 `pending`，第二次因只查找 `pending` 消息而追加相同内容，导致一条消息显示两次。

## 目标

- 同一 `runId` 的用户消息在界面中最多显示一次。
- 保留按 `pending + content` 绑定首次宿主事件的现有行为。
- 不改变会话持久化、宿主消息协议、Agent 运行流程或子智能体展示。

## 方案

在 `attachRunToUserTurn()` 中先查找相同 `runId` 的用户消息。找到时只确保 `pending: false` 并返回，不再追加；找不到时继续执行现有的 `pending + content` 回退匹配。

不选择以下方案：

- 删除 `runStarted` 处理：会破坏没有 `conversationStarted` 的恢复和既有运行路径。
- 停止宿主发送其中一个事件：扩大了消息协议和多轮会话的变更范围。
- 仅按文本去重：用户连续发送相同内容时可能误删合法消息。

## 验证

在 `test/App.test.tsx` 中从真实 Webview 入口提交一次消息，依次发送相同 `runId` 的 `conversationStarted` 与 `runStarted`，断言该文本只出现一次。随后运行 `App` 测试、类型检查、编译和 `git diff --check`。

## 关联文件

- `src/webview/App.tsx`
- `test/App.test.tsx`

