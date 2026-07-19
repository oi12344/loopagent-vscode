# 会话历史与停止生成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 收尾现有 History/会话切换/Stop 实现，并保证 runner 异步构造期间也能取消。

**架构：** 保留现有 `ConversationStore` 多行 SQLite 与消息协议。只扩展 `startAgentRun` 让它接受同步 runner 或 runner Promise，使调用方立即获得可取消 handle；不新增运行器层。

**技术栈：** TypeScript、React、Vitest、VS Code Extension Development Host、`node:sqlite`。

## 全局约束

- 不修改未关联的编辑预览行为。
- 不接入或扩展无调用方的 `ModelRunner`。
- 使用现有单一调试窗口和 `npm run debug:vscode`。

---

### Task 1：隔离嵌套 worktree 测试

**文件：**
- Modify: `vitest.config.ts`
- Modify: `.gitignore`

- [x] 运行定向测试，确认 `.claude/worktrees/**` 被误收集并导致 matcher 缺失。
- [x] 在现有 `exclude` 中加入 `.claude/worktrees/**`。
- [x] 重跑同一命令，确认 4 个文件、45 个测试通过。
- [x] 在根 `.gitignore` 中忽略 `.loopagent/`，避免本地数据库污染 Git 状态。

### Task 2：runner 构造期取消

**文件：**
- Modify: `test/agentRunner.test.ts`
- Modify: `src/extension/agentRunner.ts`
- Modify: `src/extension.ts`

**接口：**
- `StartAgentRunOptions.runner: AgentRunner | PromiseLike<AgentRunner>`
- `startAgentRun(...)` 仍同步返回 `AgentRunHandle`
- `startTask.runId` 与 `continueConversation.runId` 由 webview 生成，host 原样传给 `startAgentRun`

- [x] 增加失败测试：runner Promise 未完成时调用 `cancel()`，Promise 完成后 `runner.run()` 不得执行。
- [x] 运行 `npm test -- agentRunner.test.ts`，确认新测试按预期失败。
- [x] 在 `pumpRunMessages` 内等待 runner，并在调用 `run()` 前检查 `AbortSignal`。
- [x] 将 `extension.ts` 的 Promise `.then()` 接线改为直接把 runner Promise 传给 `startAgentRun`，立即保存 handle。
- [x] 重跑 `npm test -- agentRunner.test.ts`，确认通过。
- [x] 增加失败测试：Stop 早于 `runStarted` 时，迟到消息不得创建助手占位。
- [x] 将 webview 生成的 runId 写入 UserTurn 和 host 消息，并由 extension 透传。
- [x] 保留部分回答，删除被 Stop 的空助手占位。

### Task 3：集中验证

**文件：**
- Verify: `test/App.test.tsx`
- Verify: `test/extension/conversation/*.test.ts`
- Verify: `test/extension/multiTurnConversation.integration.test.ts`

- [x] 运行会话与 Stop 定向测试。
- [x] 运行 `npm test`、`npm run typecheck`、`npm run compile` 和 `git diff --check`。
- [x] 用单一 Extension Development Host 验证完整用户路径。
- [x] 审查 diff，确认没有把 `package.json`、编辑预览或 `ModelRunner` 混入本切片。
