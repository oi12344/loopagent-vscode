# ReAct 工具调用可观测性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 ReAct 决策的前提下，让 Process 面板显示每轮 `exploreCode` 查询和返回字符数。

**Architecture:** 复用现有 `agentEvent` 消息，不扩展跨层协议。Runner 在工具调用前后生成有界文本；Webview 继续按现有路径渲染。

**Tech Stack:** TypeScript、Vitest、VS Code Webview、现有 ReAct runtime。

## Global Constraints

- 项目文档使用中文。
- 不记录完整工具结果、密钥、绝对路径或错误堆栈。
- 不改变模型工具选择、`maxSteps` 或工具执行语义。
- 直接在当前 checkout 和当前分支开发。

---

### Task 1: 增加逐轮工具事件

**Files:**
- Modify: `src/extension/agent/reactAgentRunner.ts`
- Test: `test/reactAgentRunner.test.ts`
- Test: `test/providerRegistryCodeContext.test.ts`
- Reference: `docs/superpowers/specs/2026-07-15-react-tool-observability-design.md`

**Interfaces:**
- Consumes: `ReactAgentToolRequest.input`、工具返回的 `string`、现有 `HostToWebviewMessage.agentEvent`。
- Produces: `Running tool exploreCode (step <n>, call <n>): <query>` 与 `Tool exploreCode returned (step <n>, call <n>): <length> chars`；其他工具事件保持不变。

- [x] **Step 1: 写失败回归测试**

新增 runner 工具调用用例，要求 `exploreCode` 请求显示有界 query，完成事件显示返回字符数；同一步相同查询保留独立事件，Windows/UNC/POSIX 绝对路径和显式凭据查询整体隐藏；现有其他工具用例保持原断言。

- [x] **Step 2: 运行 RED**

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: FAIL，当前实现仍只产生 `Running tool <name>`，且没有完成事件。

- [x] **Step 3: 写最小实现**

在工具调用循环中仅为 `exploreCode` 生成带 step/call 的请求事件，并在 `toolRegistry.invoke` 成功后生成完成事件。查询摘要只接受字符串 `query`，压缩空白并截断到 200 字符；敏感查询整体隐藏。

- [x] **Step 4: 运行 GREEN**

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: PASS。

- [x] **Step 5: 集中验证**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run compile`

Run: `git diff --check`

Expected: 全部退出 0。

结果：`test/reactAgentRunner.test.ts` 先按预期 RED，修复后 GREEN；最终 `npm test` 为 50 个测试文件、274 个用例全部通过，`npm run typecheck`、生产 VSIX 打包和 `git diff --check` 均退出 0。测试仅保留仓库既有的 Node SQLite 实验警告。

- [x] **Step 6: 打包、安装和真实调用**

Run: `npm run package:vsix`

Run: `code --install-extension .artifacts/loopagent-vscode-0.0.1.vsix --force`

在现有 VS Code 窗口刷新后提问“当前react的实现”，确认 Process 显示每轮查询、返回字符数和最终状态。

结果：VSIX 已生成 29 个生产条目并覆盖安装到用户级 VS Code。隔离调试窗口单独配置 key 后，真实问题“当前react的实现”共执行 4 个 planning step、8 次不同的 `exploreCode` 查询；每次返回 1,809–6,611 字符，最终仍以 `Reached max ReAct steps: 4` 失败。该结果证明本地搜索正常返回，模型在工具始终可用时持续探索而没有保留 final 总结轮。

- [x] **Step 7: 提交**

```powershell
git add src/extension/agent/reactAgentRunner.ts test/reactAgentRunner.test.ts docs/superpowers/specs/2026-07-15-react-tool-observability-design.md docs/superpowers/plans/2026-07-15-react-tool-observability-plan.md
git diff --cached --check
git commit -m "fix(agent): expose react tool progress"
```
