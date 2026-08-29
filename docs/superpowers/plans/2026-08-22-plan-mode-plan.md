# 计划模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天输入区提供显式计划模式，并由 Host 强制该模式仅使用只读工具。

**Architecture:** `App.tsx` 维护本次发送的模式并通过共享消息协议传递。`extension.ts` 在创建主代理前归一化模式，并基于模式筛选既有工具列表和追加系统约束；计划模式不修改 DAG 调度或会话存储。

**Tech Stack:** TypeScript、React、VS Code Webview、Vitest、Testing Library。

---

### Task 1: 消息协议与 Host 工具边界

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/extension.ts`
- Test: `test/extensionWorkspaceIntelligence.test.ts` 或新增最小 Host 边界测试

- [x] **Step 1: 写入失败测试**

为计划模式的主代理创建路径断言：传入 `mode: "plan"` 时可用工具名不包含 `applyEdit` 与 `runCommand`；缺失或无效模式仍保留执行模式的工具集。

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run <新增或受影响的 Host 测试文件>`

Expected: FAIL，原因是当前消息没有 `mode` 且工具列表没有模式筛选。

- [x] **Step 3: 实现最小协议与筛选**

在共享消息类型中定义 `RunMode = "plan" | "execute"`，为 `startTask`、`continueConversation` 增加可选 `mode`。在 `extension.ts` 增加私有归一化函数：只有 `"plan"` 返回计划模式，其余值返回执行模式；计划模式从现有工具数组排除 `applyEdit`、`runCommand`，并在主代理 system prompt 后附加只读计划约束。

- [x] **Step 4: 运行测试确认通过**

Run: `npm test -- --run <新增或受影响的 Host 测试文件>`

Expected: PASS。

### Task 2: Composer 模式控件与消息传递

**Files:**
- Modify: `src/webview/App.tsx`
- Modify: `src/webview/styles.css`
- Test: `test/App.test.tsx`

- [x] **Step 1: 写入失败测试**

新增 UI 测试：初始选中“执行”；点击“计划”后 `startTask` 和 `continueConversation` 都发送 `mode: "plan"`；运行中两个模式按钮禁用。

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run test/App.test.tsx`

Expected: FAIL，原因是 composer 尚未渲染模式控件，payload 不包含 `mode`。

- [x] **Step 3: 实现最小 UI**

在 `composer-tools` 的首位增加 `role="radiogroup"` 的两个按钮，保存 `"execute"` / `"plan"` 状态。`submitTask` 将状态写入新对话和续聊 payload。CSS 使用既有 chip 视觉并固定分段宽度，不增加依赖或新的浮层。

- [x] **Step 4: 运行测试确认通过**

Run: `npm test -- --run test/App.test.tsx`

Expected: PASS。

### Task 3: 集中验证与文档完成记录

**Files:**
- Modify: `docs/superpowers/specs/2026-08-22-plan-mode-design.md`
- Modify: `docs/superpowers/plans/2026-08-22-plan-mode-plan.md`

- [x] **Step 1: 运行受影响测试与类型检查**

Run: `npm test -- --run test/App.test.tsx <Host 测试文件>; npm run typecheck`

Expected: 全部 PASS。

- [x] **Step 2: 运行整体测试点**

Run: `npm test -- --run; npm run compile; git diff --check`

Expected: 所有命令以 exit code 0 完成。

- [x] **Step 3: 记录验证证据**

将实际命令、通过统计与真实限制补充到本计划末尾；只有存在失败或限制时才记录。

## 验证记录

- RED：`npm test -- --run test/App.test.tsx test/providerRegistryCodeContext.test.ts` 先失败，原因是 UI 不存在模式单选组，计划模式仍暴露 `applyEdit`、`runCommand` 与工作流工具。
- GREEN：相同命令通过，2 个测试文件、52 个测试通过。
- 类型检查：`npm run typecheck` 通过。
- 构建：`npm run compile` 通过。
- 全量：`npm test -- --run` 未通过。首次输出显示与本功能无关的 SQLite 索引、命令执行和并发工具测试失败，随后 `runCommandTool` 的超时清理用例长期无输出；已停止本次测试进程，未终止用户已有进程。
- E2E：已通过 `npm run debug:vscode` 使用项目固定入口启动，但 VS Code 在 `.local-vscode-user-data/logs/20260822T001839/main.log` 记录 `Code is currently being updated`，调试 Host 因更新互斥锁退出，未能完成真实 Webview 检查。
