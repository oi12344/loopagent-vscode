# 整分支复审 Critical 修复记录

## 修复

- 用户审批门禁现在保存 `waitingFor` 后发出 `runInterrupted`，消息带 `runId`、`conversationId` 和任务；现有 Resume 可从 `designApproval`、`specReview`、`planApproval` 继续。
- AgentPool 将 fresh context 和角色所需的结构化工具写入 `SubagentRunRequest`。实现者/修复者要求 `reportSubagentResult`，审查者/终审者要求 `reportSubagentResult` 与 `reportReview`。
- `AgentRunRequest` 支持 `initialMessages` 和 `requiredToolNames`；Superpowers 子 Agent 入口把它们传入真实 ReAct runner。
- ReAct runner 注入初始消息并记录成功工具调用。缺少 required tool 时最多追加两次约束提示，仍缺失则发出 `runFailed`，不会伪造 `runFinished`。

## 验证

- `npm test -- workflowSupervisor agentPool reactAgentRunner agentRunner providerRegistryCodeContext extensionWorkspaceIntelligence`：51 个测试通过。
- `npm run typecheck`：通过。
- `npm run compile`：通过。
- `git diff --check`：通过。

## 范围

只修改了 Supervisor、AgentPool、AgentRunRequest、ReAct runner、provider registry、Extension 子 Agent 入口及对应测试；未修改 `package-lock.json`、Task 7 文件或项目文档。

## 整分支复审补充

- 审批门禁测试断言首轮和恢复轮次均产生 `runInterrupted`，并继续推进到下一门禁。
- 生产子 Agent 创建路径传递 `request.messages` 为 `initialMessages`，并按角色传递 required tool 名称；普通 ask runner 不设置 required tool，保持原行为。

## Important 修复

- required tool 缺失时，ReAct final/recovery 轮保持 `toolChoice: "auto"`，允许模型真正调用报告工具；final step 的 tool requests 先执行，成功后下一轮才切换为 `none`。
- 回归测试覆盖 `maxSteps` 到达、缺报告、补救调用 `reportSubagentResult` 和最终 `runFinished`。
- `npm test -- reactAgentRunner agentPool workflowSupervisor`：40 个测试通过。

## 技能正文与预检接线

- Supervisor 在 fresh run 和 Resume 时重新加载 checkpoint 中的技能名；正文通过 dispatch context 进入 AgentPool fresh messages，再作为 ReAct `initialMessages` 进入 modelTurn。
- Extension 仅提供当前 workspace，不注入仓库特定计划路径。计划路径只由 checkpoint 或创建 Supervisor 时的显式 option 声明，并保存到 checkpoint。
- Fresh workflow 没有 `planPath`、`taskIndex` 或 `baseCommit` 时不要求预先存在计划和 ledger；只有 checkpoint 声明计划时才校验计划，已有任务进度或 workspace 已有 ledger 时才校验 `.superpowers/sdd/progress.md`。
- 需要校验的文件必须位于 workspace、为普通文件且非空；缺失、逃逸或空文件均保存明确 `blocked` 原因。空 workspace 的 fresh edit 可通过 preflight，带有效计划和 ledger 的 Resume 可继续执行。
- 本轮验证：相关测试 56 项、全量测试 458 项、`npm run typecheck`、`npm run compile` 和 `git diff --check` 均通过。
