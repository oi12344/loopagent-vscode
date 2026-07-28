# 用户消息重复显示修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一条新会话消息在收到 `conversationStarted` 和 `runStarted` 后仍只显示一次。

**Architecture:** 保留两个宿主事件和现有乐观渲染，只让共享的 `attachRunToUserTurn()` 按 `runId` 幂等。首次绑定继续使用 `pending + content` 回退，避免改变其他运行路径。

**Tech Stack:** React、TypeScript、Vitest、Testing Library

## Global Constraints

- 不修改宿主消息协议或会话持久化。
- 不按消息文本全局去重。
- 不修改子智能体运行和展示逻辑。
- 不新增依赖。

---

### Task 1: 复现并修复重复用户消息

**Files:**
- Modify: `test/App.test.tsx`
- Modify: `src/webview/App.tsx`
- Update: `docs/superpowers/plans/2026-07-28-duplicate-user-message-plan.md`

**Interfaces:**
- Consumes: `attachRunToUserTurn(turns, runId, task, createTurnId)`
- Produces: 同一 `runId` 最多对应一个 `UserTurn`

- [ ] **Step 1: 写失败测试**

在 `test/App.test.tsx` 中提交 `Inspect the project`，然后依次发送：

```typescript
postHostMessage({ type: "conversationStarted", conversationId: "conv-1", runId: "run-1", userMessage: "Inspect the project" });
postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
expect(screen.getAllByText("Inspect the project")).toHaveLength(1);
```

- [ ] **Step 2: 确认测试因重复消息失败**

Run: `npm.cmd test -- --reporter=dot test/App.test.tsx`

Expected: 新用例 FAIL，实际找到两条 `Inspect the project`。

- [ ] **Step 3: 实现最小幂等绑定**

在 `attachRunToUserTurn()` 的 `pending + content` 查找之前增加相同 `runId` 查找；找到时把对应用户消息更新为 `pending: false`，不追加新消息。

- [ ] **Step 4: 运行受影响验证**

```powershell
npm.cmd test -- --reporter=dot test/App.test.tsx
npm.cmd run typecheck
npm.cmd run compile
git diff --check
```

Expected: 所有命令 exit code 0。

- [ ] **Step 5: 同一调试窗口验证**

刷新现有唯一 Extension Development Host，在 LoopAgent 面板发送一条新消息，确认用户消息只显示一次。

- [ ] **Step 6: 更新记录并提交**

勾选本计划步骤并记录验证结果；提交仅包含上述四个文件，不包含 `.codegraph`。

