# 子代理固定角色模板 — 执行计划

## 成功标准

主代理创建子代理时可指定固定角色（`explorer` / `reviewer` / `planner`），每个角色有稳定的
system prompt 和工具白名单。省略角色时回退 `explorer`，现有调用保持兼容。角色权限只能是
父运行只读工具集的子集，任何角色都拿不到编辑、命令、报告或调度权限。

依据设计规范：`docs/superpowers/specs/2026-07-24-subagent-role-profile-design.md`

## 关键设计决策（来自规范）

- 采用「固定角色模板 + 按任务无状态实例」，不做常驻角色、不做跨任务记忆、不允许调用方动态传 prompt/工具。
- 角色模板由扩展内部维护，`CreateSubagentConfig` 只新增 `role?` 字段。
- `toolHints` 只能在「角色白名单 ∩ 父运行只读工具」的交集内进一步收窄，不能扩权。
- 子代理快照要能读到已解析的角色 ID。

## 文件顺序

### Task 1: 角色类型与创建参数 — `src/extension/agent/workflow/types.ts`

- 新增 `SubagentRoleId = "explorer" | "reviewer" | "planner"`。
- 新增 `SubagentRoleProfile = { id; systemPrompt; allowedTools: readonly string[] }`。
- `CreateSubagentConfig` 增加可选 `role?: SubagentRoleId`。
- `SubagentRunnerFactoryInput` 增加 `role: SubagentRoleId`（供 provider 侧选 prompt）。

### Task 2: 角色注册表 — 新增 `src/extension/agent/workflow/roleRegistry.ts`

- 先写 `test/workflow/roleRegistry.test.ts`：默认解析 `explorer`、未知角色抛错、三角色各有非空
  prompt 和白名单。
- 导出 `resolveRole(role?: SubagentRoleId): SubagentRoleProfile` 和三个固定模板。
- 三角色白名单均为 `["exploreCode", "readFile"]`（只读），prompt 按规范表格的职责/输出要求编写。
- 未知角色在此层直接抛错（创建阶段拒绝）。

### Task 3: 工具路由按角色收窄 — `src/extension/agent/workflow/toolRouter.ts`

- 先在 `test/workflow/toolRouter.test.ts` 补用例：角色白名单先过滤可用工具，再套用现有
  `toolHints` / 关键词 / 兜底逻辑；`toolHints` 命中白名单外的工具时被忽略。
- `selectTools` 增加 `allowedTools` 参数（角色白名单），先按白名单过滤 `availableTools`，
  空集时返回空（允许纯推理任务）。保持 `HIGH_COST_TOOLS` 现有行为。

### Task 4: 子代理上下文携带角色 — `src/extension/agent/subagentContext.ts`

- 在 `test/subagentContext.test.ts` 补：快照包含 `role` 字段。
- `CreateSubagentContextInput` 与 `SubagentContextSnapshot` 增加 `role: SubagentRoleId`。

### Task 5: 协调器解析角色 — `src/extension/agent/workflowOrchestrator.ts`

- 在 `test/workflowOrchestrator.test.ts` 补：默认角色为 `explorer`、未知角色创建即失败（不生成状态）、
  角色白名单参与 `selectTools`、`createRunner` 收到 `role`。
- `createSubagent` 里 `resolveRole(config.role)`，把 `profile.allowedTools` 传给 `selectTools`，
  角色存入上下文；`start()` 调 `createRunner` 时透传 `role`。
- 未知角色由 `resolveRole` 抛错，`createSubagent` 不写入 `entries`/`graph`。

### Task 6: provider 用角色 prompt 建 child runner — `src/extension/model/providerRegistry.ts`

- 在 `test/providerRegistryCodeContext.test.ts` 补：不同角色的 child runner 使用对应固定 system
  prompt（叠加运行时上下文、不含 memory）。
- `createRunner` 从 `input.role` 取 `profile.systemPrompt`，替换当前写死的
  `runtimeSystemPromptProvider`：新 provider = `[profile.systemPrompt, runtimePrompt]`。
- 抽出运行时上下文渲染，避免与父代理 `REACT_SYSTEM_PROMPT` 逻辑重复。

### Task 7: 工具入参放开 role — `src/extension/agent/workflowTools.ts`

- 在 `test/workflowTools.test.ts` 补：`spawnSubagent` 接受 `role`、校验为已知枚举、透传到
  `createSubagent`。
- `spawnSubagent` inputSchema 增加 `role`（enum 三值），`parseCreateSubagentInput` 解析并校验。

### Task 8: 端到端与验证 — `test/workflowEnd2End.test.ts`

- 补一条端到端用例：按不同角色创建子代理，断言工具白名单收窄与角色透传到 runner 输入。
- 运行受影响测试、`npm run typecheck`、全量测试、`git diff --check`。
- 更新设计规范状态为「已实现」，回填完成记录。

## 风险控制

- 角色白名单与父运行只读工具取交集，无论 `toolHints` 如何都不能扩权（编辑/命令/报告/调度均隔离）。
- 未知角色在创建阶段拒绝，不产生子代理状态与资源。
- 不改 `AgentRunner` 协议、不加依赖、不加持久化、不加角色 UI（规范非目标）。
- 子代理仍不加载项目 memory、不接收父代理完整历史。

## 完成记录

- [x] 角色类型、注册表与工具路由收窄
- [x] 上下文与协调器解析角色
- [x] provider 角色 prompt 与工具入参
- [x] 端到端测试、类型检查、全量验证

## 本次验证

- `npm test -- test/workflow/roleRegistry.test.ts`：5 个测试通过。
- `npm test -- test/workflow/toolRouter.test.ts`：9 个测试通过。
- `npm test -- test/subagentContext.test.ts`：5 个测试通过。
- `npm test -- test/workflowOrchestrator.test.ts`：15 个测试通过。
- `npm test -- test/workflowTools.test.ts`：15 个测试通过。
- `npm test -- test/providerRegistryCodeContext.test.ts`：13 个测试通过。
- `npm test -- test/workflowEnd2End.test.ts`：2 个测试通过。
- `npm run typecheck`：通过。
- `npm test -- --reporter=dot`：67 个文件，522 通过（1 个偶发失败 runCommandTool 进程超时，与本次改动无关，单独运行时通过）。
- `git diff --check`：通过（LF 换行符警告，非实质错误）。
