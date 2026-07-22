# Superpowers Harness 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 obra/superpowers v6.1.1 的全部官方技能接入 LoopAgent，在 edit 模式提供可恢复的多智能体实现、审查和验证闭环。

**Architecture:** 固定打包官方技能原文，由 `SkillCatalog` 按需加载；`WorkflowSupervisor` 管理阶段、用户门禁、checkpoint 和台账；`AgentPool` 基于现有 ReAct runner 为实现者、审查者和修复者创建独立上下文。ask 模式保持现有 ReAct，edit 模式进入 Superpowers。

**Tech Stack:** TypeScript、VS Code Extension API、Node.js SQLite、React Webview、Vitest、Git Bash、现有 DeepSeek provider。

## Global Constraints

- 官方资源固定 v6.1.1，全部 14 个技能、直接引用、脚本和 MIT LICENSE 必须进入 VSIX。
- 官方 `SKILL.md` 原文不得改写；适配说明放在独立 harness prompt 和宿主工具中。
- 实现/修复 Agent 串行写入；只读调查才可并行，同一时间不得存在两个写入型 Agent。
- 项目命令继续使用现有 `runCommand` 确认框，编辑继续使用现有预览边界。
- 技能和引用路径限制在固定资源根目录；运行时不联网下载或更新技能。
- 项目规则和用户指令优先于 `using-git-worktrees`，未明确允许时不得自动创建 worktree。
- 文档使用中文；每个任务结束运行覆盖测试并提交。
- 调试验证只使用一个固定 Extension Development Host，入口为 `npm run debug:vscode`。

## 文件边界

`resources/superpowers/` 保存官方资源；`scripts/vendor-superpowers.ps1` 负责下载和清单生成；`src/extension/superpowers/{superpowersTypes,skillCatalog,workflowStore,agentPool,superpowersTools,workflowSupervisor,superpowersAgentRunner}.ts` 分别负责类型、加载、持久化、子 Agent、工具和状态机；`src/shared/messages.ts`、`src/extension/agentRunner.ts`、`src/extension/model/providerRegistry.ts`、`src/extension.ts`、`src/webview/{App.tsx,styles.css}` 接入现有运行时；测试放在 `test/superpowers/` 及现有对应测试文件。

---

### Task 1: 固定官方资源并验证 VSIX

**Files:** Create `scripts/vendor-superpowers.ps1`, `resources/superpowers/{manifest.json,LICENSE,skills/**}`; modify `scripts/package-vsix.mjs`; test `test/superpowers/resourceIntegrity.test.ts`。

**Interfaces:** 脚本命令为 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vendor-superpowers.ps1 -Tag v6.1.1 -Destination resources/superpowers`；清单为 `{ version, skills: [{ name, description, path }] }`。

- [ ] 写失败测试，断言版本为 `6.1.1`、14 个技能名称完整、每个 `SKILL.md` 存在、LICENSE 存在：

```ts
const manifest = readManifest();
expect(manifest.version).toBe("6.1.1");
expect(manifest.skills).toHaveLength(14);
expect(manifest.skills.map((s) => s.name)).toContain("subagent-driven-development");
expect(fs.existsSync(resourcesPath("LICENSE"))).toBe(true);
```

- [ ] 运行 `npm test -- resourceIntegrity`，确认因资源缺失失败。
- [ ] 脚本下载 GitHub tag zip，校验顶层目录/LICENSE，复制官方 `skills`、技能直接引用和脚本，读取 frontmatter 生成 manifest；非 v6.1.1 或缺文件以非零退出。
- [ ] 运行脚本、`npm test -- resourceIntegrity`、`npm run package:vsix`；确认 VSIX 包含 resources。
- [ ] 提交：`git add scripts/vendor-superpowers.ps1 resources/superpowers scripts/package-vsix.mjs test/superpowers/resourceIntegrity.test.ts; git commit -m "feat(superpowers): vendor official v6.1.1 skills"`。

### Task 2: 安全 SkillCatalog

**Files:** Create `src/extension/superpowers/superpowersTypes.ts`, `src/extension/superpowers/skillCatalog.ts`, `test/superpowers/skillCatalog.test.ts`。

**Interfaces:**

```ts
type SkillCatalog = {
  list(): readonly SuperpowersSkill[];
  load(name: string): Promise<LoadedSkill>;
  loadResource(name: string, relativePath: string): Promise<string>;
};
type SuperpowersSkill = { name: string; description: string; skillPath: string };
type LoadedSkill = SuperpowersSkill & { content: string };
```

- [ ] 先写并运行失败测试：加载 `brainstorming` 正文；`../LICENSE`、绝对路径和符号链接逃逸必须分别拒绝。
- [ ] 用 Node `fs/promises` 读取 JSON manifest 和 UTF-8 文件；用 `resolve`/`relative`/真实路径检查阻断路径穿越，不新增 YAML 依赖。
- [ ] 运行 `npm test -- skillCatalog`、`npm run typecheck`。
- [ ] 提交：`git add src/extension/superpowers/superpowersTypes.ts src/extension/superpowers/skillCatalog.ts test/superpowers/skillCatalog.test.ts; git commit -m "feat(superpowers): add safe skill catalog"`。

### Task 3: workflow checkpoint

**Files:** Modify `src/shared/chatTypes.ts`, `src/extension/conversation/conversationStore.ts`, `src/extension/conversation/persistentConversationStore.ts`; create `src/extension/superpowers/workflowStore.ts`, `test/superpowers/workflowStore.test.ts`。

**Interfaces:**

```ts
type WorkflowPhase = "bootstrap" | "route" | "brainstorming" | "designApproval" | "writeSpec" | "specReview" | "writePlan" | "planApproval" | "preflight" | "implement" | "review" | "fix" | "finalReview" | "verification" | "finished" | "blocked";
type SuperpowersCheckpoint = { version: 1; conversationId: string; runId: string; phase: WorkflowPhase; skillNames: string[]; planPath?: string; taskIndex: number; activeAgentId?: string; waitingFor?: string; baseCommit?: string; updatedAt: number };
type WorkflowStore = { save(c: SuperpowersCheckpoint): void; load(id: string): SuperpowersCheckpoint | undefined; clear(id: string): void };
```

- [ ] 写失败 round-trip/clear 测试：保存 `phase: "review"` 后读取相等，clear 后为 `undefined`。
- [ ] 复用现有 SQLite 迁移模式，新增 `superpowers_workflow` 表，按 `conversation_id` upsert；读取校验 version/phase/id，错误不静默重置。
- [ ] 运行 `npm test -- workflowStore conversationManager persistentConversationStore`。
- [ ] 提交：`git add src/shared/chatTypes.ts src/extension/conversation src/extension/superpowers/workflowStore.ts test/superpowers/workflowStore.test.ts; git commit -m "feat(superpowers): persist workflow checkpoints"`。

### Task 4: AgentPool 和结构化 Agent 结果

**Files:** Create `src/extension/superpowers/agentPool.ts`, `src/extension/superpowers/superpowersTools.ts`, `test/superpowers/agentPool.test.ts`, `test/superpowers/superpowersTools.test.ts`; modify `src/extension/agent/reactTypes.ts`。

**Interfaces:** `AgentRole = "implementer" | "taskReviewer" | "fixer" | "finalReviewer"`；`AgentPool.dispatch({ agentId, role, task, model, signal }): Promise<SubagentResult>`；`cancelAll(): void`；工具名固定为 `loadSkill`、`loadSkillResource`、`runBundledScript`、`reportSubagentResult`、`reportReview`；结果状态为 `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`，审查结果同时含 `specCompliant`、`qualityApproved` 和 `findings`。

- [ ] 写失败测试：第一个 implementer 未结束时，第二个 fixer dispatch 拒绝并报 `writer already active`；每次 dispatch 的消息数组和 run ID 必须不同。
- [ ] 工具失败测试覆盖按需技能/引用加载、`../` 路径拒绝、非白名单脚本拒绝和 Git Bash 缺失错误；`runBundledScript` 只能执行 manifest 中固定的官方脚本。
- [ ] 实现 fresh context，只传 brief、全局约束、相关路径和前序 report；两个 report 工具校验 schema，非法结果只允许一次纠正回合。
- [ ] 运行 `npm test -- agentPool superpowersTools reactAgentRunner`。
- [ ] 提交：`git add src/extension/superpowers/agentPool.ts src/extension/superpowers/superpowersTools.ts src/extension/agent/reactTypes.ts test/superpowers/agentPool.test.ts test/superpowers/superpowersTools.test.ts; git commit -m "feat(superpowers): add structured subagent pool"`。

### Task 5: Supervisor 状态机

**Files:** Create `src/extension/superpowers/workflowSupervisor.ts`, `src/extension/superpowers/superpowersAgentRunner.ts`, `test/superpowers/workflowSupervisor.test.ts`。

**Interfaces:** `createWorkflowSupervisor(options): WorkflowSupervisor`；`WorkflowSupervisor.run(request: AgentRunRequest): AsyncIterable<HostToWebviewMessage>`；恢复状态支持 `resumeState.kind === "superpowers"`。

- [ ] 写失败纵向测试：脚本化 Agent 依次返回实现通过、审查不通过、修复通过、复审通过，断言角色顺序为 `implementer → taskReviewer → fixer → taskReviewer → finalReviewer`，最终产生 `runFinished`。
- [ ] 实现 `BOOTSTRAP → ROUTE → BRAINSTORMING → DESIGN_APPROVAL → WRITE_SPEC → SPEC_REVIEW → WRITE_PLAN → PLAN_APPROVAL`；每个用户门禁保存 `waitingFor` 并结束当前 run，后续 continue 从 checkpoint 继续。
- [ ] 实施阶段按任务 brief、实现、审查、修复/复审、ledger、整分支终审顺序执行；未加载适用技能时拒绝回答/编辑/命令。
- [ ] 处理 `NEEDS_CONTEXT`、`BLOCKED`、计划冲突、提交/ledger 不一致和取消信号；阶段边界和 Agent 生命周期都写 checkpoint。
- [ ] 运行 `npm test -- workflowSupervisor`，提交：`git add src/extension/superpowers/workflowSupervisor.ts src/extension/superpowers/superpowersAgentRunner.ts test/superpowers/workflowSupervisor.test.ts; git commit -m "feat(superpowers): orchestrate gated workflow"`。

### Task 6: provider、Extension、恢复和 Webview 接线

**Files:** Modify `src/extension/agentRunner.ts`, `src/extension/model/providerRegistry.ts`, `src/extension.ts`, `src/shared/messages.ts`, `src/webview/App.tsx`, `src/webview/styles.css`; tests `test/providerRegistryCodeContext.test.ts`, `test/extension/multiTurnConversation.integration.test.ts`, `test/App.test.tsx`。

**Interfaces:** `AgentResumeState` 增加 `{ kind: "superpowers"; checkpoint: SuperpowersCheckpoint }`；`request.mode === "edit"` 创建 Superpowers runner，`ask` 保持 React runner；新增 `workflowStateChanged` 和 `subagentStateChanged`。

- [ ] 先扩展配置和 Webview 失败测试：edit/ask 选择不同 runner；通过 `window.dispatchEvent(new MessageEvent("message", { data: workflowStateChanged }))` 注入事件，断言 phase 和 Agent 状态出现且聊天正文不消失。
- [ ] 在 Extension 生命周期创建并复用 catalog/store/pool，保持单 `activeRun`；资源初始化失败时 edit 返回具体资源路径错误但 ask 仍可用；Stop 级联取消并保存 checkpoint，Resume 校验后从同一 conversation 继续，完成/失败时清理或保留状态。
- [ ] Webview 增加紧凑流程时间线，不新增管理页面，保留现有 Stop/Resume、reasoning 和 assistant 内容。
- [ ] 运行 `npm test -- providerRegistryCodeContext multiTurnConversation.integration App.test.tsx agentRunner`、`npm run typecheck`、`npm run compile`。
- [ ] 提交：`git add src/extension/agentRunner.ts src/extension/model/providerRegistry.ts src/extension.ts src/shared/messages.ts src/webview test/providerRegistryCodeContext.test.ts test/extension/multiTurnConversation.integration.test.ts test/App.test.tsx; git commit -m "feat(superpowers): wire edit workflow and progress"`。

### Task 7: 集中验证、VSIX 和真实用户路径

**Files:** Modify `docs/superpowers/specs/2026-07-21-superpowers-harness-integration-design.md` and this plan only with actual results; modify `.vscodeignore` only if the resource test proves omission。

- [ ] 运行 `npm test`、`npm run typecheck`、`npm run compile`、`npm run package:vsix`、`git diff --check`；确认所有命令退出码为 0，VSIX 含 14 个技能和 LICENSE。
- [ ] 使用唯一 `npm run debug:vscode` 窗口执行 `LoopAgent: Open Panel`，提交小型 edit 请求，批准设计/规格/计划，观察实现、审查、修复/复审和最终结果；中途 Stop 一次再 Resume，确认不重复已通过任务且无第二个写 Agent。
- [ ] 检查路径穿越、未确认命令、非白名单脚本、非法 Agent 结果、缺失资源和 checkpoint 不一致均进入明确失败状态。
- [ ] 只记录实际执行过的测试文件/用例数量、VSIX 路径、调试结果、提交范围和限制；更新规格/计划完成记录。
- [ ] 提交：`git add docs/superpowers/specs/2026-07-21-superpowers-harness-integration-design.md docs/superpowers/plans/2026-07-21-superpowers-harness-integration-plan.md; git commit -m "docs: record superpowers integration verification"`。

#### Task 7 实际结果（2026-07-22，源码复审修复后复验）

- [x] 已执行 `npm test`（65 文件、458 用例）、`npm run typecheck`、`npm run compile`、`npm run package:vsix` 和 `git diff --check`，退出码均为 0。
- [x] 已核对 `.artifacts/loopagent-vscode-0.0.1.vsix`：67 个条目，含 14 个技能正文与 `LICENSE`。
- [x] 已执行 `resourceIntegrity`、`skillCatalog`、`superpowersTools`、`workflowStore` 和 `workflowSupervisor` 边界测试：5 文件、24 用例均通过。
- [x] 最终整分支复审发现并修复两个 Critical：用户审批门禁改为可由现有 Resume 消费的 `runInterrupted`；AgentPool fresh context 和必需结构化报告工具已贯穿真实 ReAct runner。随后补充 required-tool 补救轮 `toolChoice: auto` 修复，相关复审与 40/40 聚焦回归通过。
- [x] 后续整分支复审补齐技能正文注入与 checkpoint 驱动预检：fresh/Resume 均把适用技能正文传入 ReAct；产品运行时不再绑定本仓库计划路径，fresh workspace 不预要求 plan/ledger，Resume 仅校验 checkpoint 已声明的工件。
- [ ] 已在唯一 Extension Development Host 中打开 LoopAgent 面板，但管理员 VS Code 的 UI 自动化层无法点击或填值，无法提交 edit 请求；因此审批门禁、implementer/reviewer/fixer/finalReviewer、Stop/Resume、无重复任务和单 writer 的真实路径仍未验证，未将自动化测试替代为真实路径结论。
- [x] 已关闭本次调试宿主；`127.0.0.1:9333` 不再监听。

## 完成标准

- [ ] v6.1.1 全部技能进入 VSIX，资源、路径安全和路由门禁测试通过。
- [ ] edit 模式从 bootstrap 到最终验证走通，ask 模式回归通过。
- [ ] 实现、审查、修复和终审使用 fresh context，写入 Agent 串行。
- [ ] 设计、规格、计划、Stop/Resume 和状态不一致均有明确门禁。
- [ ] `npm test`、`npm run typecheck`、`npm run compile`、`npm run package:vsix` 和 `git diff --check` 全部通过，且唯一调试窗口完成真实用户路径。
