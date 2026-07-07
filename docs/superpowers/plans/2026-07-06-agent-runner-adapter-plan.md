# Agent Runner 适配层实施计划

SUB-SKILL: task-by-task

## Goal

把假运行流收口到可替换的 `AgentRunner` 边界，使 Extension Host 可以用统一方式启动、回传和失败处理一次任务运行。

## Architecture

`src/extension/agentRunner.ts` 负责运行生命周期，`src/extension/fakeRun.ts` 负责当前开发用假 runner，`src/extension.ts` 负责 VS Code Webview 面板和消息桥。Webview 消息协议继续复用 `src/shared/messages.ts`。

## Tech Stack

TypeScript、VS Code Extension API、Vitest、React Webview 现有消息协议。

## Tasks

1. 新增 `test/agentRunner.test.ts`：
   - 验证 `startAgentRun` 把 runner 的异步消息逐条发送给 `postMessage`。
   - 验证 runner 抛错时发送 `runFailed`。
   - 验证 `cancel()` 会触发传入 runner 的 `AbortSignal`。

2. 运行红灯测试：
   ```powershell
   npm test -- test/agentRunner.test.ts
   ```
   预期：因为 `src/extension/agentRunner.ts` 尚不存在而失败。

3. 新增 `src/extension/agentRunner.ts`：
   - 定义 `AgentRunner`、`AgentRunRequest`、`AgentRunHandle`。
   - 实现 `startAgentRun`，生成 `runId`，启动异步 pump，处理异常并回传 `runFailed`。
   - `postMessage` 支持同步返回、`Promise` 或 `PromiseLike`。

4. 更新 `src/extension/fakeRun.ts`：
   - 保留 `createFakeRunMessages`。
   - 新增 `fakeAgentRunner`，把已有假消息转换为异步消息流。

5. 更新 `src/extension.ts`：
   - 删除本地 `postFakeRun`。
   - 使用 `startAgentRun` 和 `fakeAgentRunner`。
   - 面板关闭时取消当前运行；新任务开始时取消上一条未结束运行。

6. 运行验证：
   ```powershell
   npm test -- --run
   npm run typecheck
   npm run compile
   ```

7. 清理检查：
   - 确认没有未使用导出、过期 TODO 或调试代码。
   - 确认文档与源码行为一致。

## 实际验证记录

2026-07-06 已完成以下验证：

- `npm test -- test/agentRunner.test.ts`：通过，1 个测试文件、3 个测试通过。
- `npm test -- --run`：通过，5 个测试文件、9 个测试通过。
- `npm run typecheck`：通过。
- `npm run compile`：通过。

## 当前状态

`src/extension/agentRunner.ts` 已成为 Extension Host 的运行适配层；`src/extension/fakeRun.ts` 继续作为当前开发 runner，后续真实 LoopAgent runtime 可以替换 `fakeAgentRunner`，无需改动 Webview UI 消息协议。
