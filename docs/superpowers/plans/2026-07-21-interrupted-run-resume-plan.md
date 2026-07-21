# 中断运行恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保存被 Stop 的 ReAct 运行 checkpoint，并通过显式 Resume 从最近可恢复 step 继续。

**Architecture:** ConversationStore 按 conversationId 保存 JSON checkpoint；React runner 在关键边界写 checkpoint 并从 resume state 初始化消息序列；Extension/Webview 增加中断提示和 Resume 消息，保持现有 AgentRunner 主流程。

**Tech Stack:** TypeScript、Node SQLite、React Webview、Vitest、VS Code Extension API。

## Global Constraints

- 不自动恢复模型调用；Resume 必须由用户确认。
- Stop 发生在模型请求期间时，从该 step 重新请求。
- 不新增依赖，不改变现有普通单轮/多轮对话语义。
- 项目文档使用中文，验证复用固定 VS Code 调试目录和窗口。

---

### Task 1: 增加 checkpoint 类型与 ConversationStore 持久化

**Files:**
- Modify: `src/shared/chatTypes.ts`
- Modify: `src/extension/conversation/conversationStore.ts`
- Modify: `src/extension/conversation/persistentConversationStore.ts`
- Test: `test/extension/conversation/conversationManager.test.ts`
- Test: `test/extension/conversation/persistentConversationStore.test.ts`

**Interfaces:**
- Produces `InterruptedRunCheckpoint`、`saveInterruptedRun`、`loadInterruptedRun`、`clearInterruptedRun`。

- [ ] 写失败测试：内存和 SQLite store 能保存、读取、覆盖、清理 checkpoint，重开 SQLite 后仍可读取。
- [ ] 运行 `npm test -- conversationManager.test.ts persistentConversationStore.test.ts`，确认因接口/实现缺失失败。
- [ ] 在 `chatTypes.ts` 定义包含 `conversationId`、`runId`、`task`、`mode`、`step`、`messages`、`updatedAt` 的 JSON 可序列化 checkpoint。
- [ ] 给两个 store 增加接口实现；SQLite 增加 `interrupted_run` 表并按 `conversation_id` upsert。
- [ ] 重跑上述测试并确认通过。

### Task 2: 让 ReAct runner 保存和恢复内部消息

**Files:**
- Modify: `src/extension/agentRunner.ts`
- Modify: `src/extension/agent/reactTypes.ts`
- Modify: `src/extension/agent/reactAgentRunner.ts`
- Test: `test/agentRunner.test.ts`
- Test: `test/reactAgentRunner.test.ts`

**Interfaces:**
- `AgentRunRequest.resumeState?: { kind: "react"; checkpoint: InterruptedRunCheckpoint }`。
- `CreateReactAgentRunnerOptions.onCheckpoint?: (checkpoint: InterruptedRunCheckpoint) => void | Promise<void>`。

- [ ] 写失败测试：runner 在模型调用前保存 step；工具结果后保存完整 assistant/tool 消息；带 resumeState 时不重复追加原始 user 任务。
- [ ] 运行 `npm test -- agentRunner.test.ts reactAgentRunner.test.ts`，确认失败原因是缺少 checkpoint 行为。
- [ ] 将 checkpoint 写入点放在模型调用前、assistant tool request 加入后、每批 tool result 加入后；完成/失败不在 runner 内清理。
- [ ] 从 resume checkpoint 初始化 `messages` 和下一步编号，沿用父级 AbortSignal。
- [ ] 重跑受影响测试并确认原有 ReAct 行为不变。

### Task 3: Host 接线 Stop、checkpoint 和 Resume

**Files:**
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `src/extension.ts`
- Modify: `src/shared/messages.ts`
- Test: `test/extension/multiTurnConversation.integration.test.ts`

**Interfaces:**
- Adds Webview messages `resumeRun` and Host message `runInterrupted`。

- [ ] 写失败测试：Stop 后保留 checkpoint 并发送 `runInterrupted`；Resume 读取 checkpoint 并传给 runner；完成后清理。
- [ ] 运行集成测试确认消息类型和 host 分支尚未实现。
- [ ] 将 store callback 注入 configured runner，`executeRun` 在结束时清理 checkpoint，在 Stop 完成后发送中断消息。
- [ ] 新增 `handleResumeRun`，恢复同一 conversation，生成新的 runId，保持 activeRun 单例。
- [ ] 重跑集成测试并确认通过。

### Task 4: Webview Resume 操作

**Files:**
- Modify: `src/webview/App.tsx`
- Modify: `src/webview/styles.css`
- Test: `test/App.test.tsx`

**Interfaces:**
- `runInterrupted` 在当前助手回合显示 Resume 操作。
- Resume 发送 `{ type: "resumeRun", conversationId }`。

- [ ] 写失败测试：收到 `runInterrupted` 后显示 Resume；点击后发送正确消息并进入运行态。
- [ ] 运行 `npm test -- App.test.tsx` 确认失败。
- [ ] 增加最小按钮和状态处理，不引入新的状态容器。
- [ ] 重跑 App 测试并确认通过。

### Task 5: 集中验证与清理

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-interrupted-run-resume-design.md`
- Modify: `docs/superpowers/plans/2026-07-21-interrupted-run-resume-plan.md`

- [ ] 运行 `npm test -- agentRunner.test.ts reactAgentRunner.test.ts App.test.tsx extension/multiTurnConversation.integration.test.ts conversationManager.test.ts persistentConversationStore.test.ts`。
- [ ] 运行 `npm run typecheck`、`npm run compile`、`git diff --check`。
- [ ] 在固定调试窗口验证：工具执行中 Stop、刷新面板、点击 Resume、正常完成后再次刷新不显示旧 Resume。
- [ ] 删除临时调试输出，更新文档完成状态，集中审查 diff。

## 完成记录

- [x] ConversationStore 已支持内存和 SQLite checkpoint 的保存、恢复、覆盖和清理。
- [x] ReAct runner 已保存 step 边界和 tool 消息，并支持从 checkpoint 继续。
- [x] Host/Webview 已接入 Stop 后的 `runInterrupted` 和显式 Resume。
- [x] 已通过 `npm test`（60 个测试文件、415 个用例）、`npm run typecheck`、`npm run compile`、`git diff --check`。
- [ ] 尚未在真实模型凭据下执行人工 Stop/Resume；需要在固定 VS Code 调试窗口中完成一次交互验证。
