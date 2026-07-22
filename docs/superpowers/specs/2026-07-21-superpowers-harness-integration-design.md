# Superpowers v6.1.1 Harness 集成设计

## 目标

将官方 `obra/superpowers` v6.1.1 的全部 14 个技能原样接入 LoopAgent，使 VS Code 扩展具备真实的 Superpowers 工作流能力：技能发现与路由、设计和计划审批、多智能体实现与审查、任务台账、可恢复执行，以及完成前验证。

集成目标是增加 LoopAgent 的宿主适配层，不重写官方技能正文，也不把工作流简化成一段系统提示词。

## 范围

### 包含

- 将官方 `skills/`、引用文件、脚本和 MIT LICENSE 固定打包到扩展资源，版本锁定 v6.1.1。
- 会话启动和恢复时注入 `using-superpowers`，按需加载其他技能和引用资源。
- 增加 Supervisor 和 AgentPool，支持上游 `subagent-driven-development` 的顺序实现、任务审查、修复、复审和整分支终审。
- 复用现有 ReAct runner、模型 provider、工具注册表、取消信号和会话持久化。
- 保存 workflow checkpoint，并复用 `.superpowers/sdd/progress.md` 作为长期进度台账。
- 为 Webview 增加结构化工作流和子 Agent 进度事件。
- 增加资源完整性、状态机、恢复、安全边界和真实用户路径验证。

### 不包含

- 不修改官方技能正文或把技能内容复制成 TypeScript 规则。
- 不增加新的模型供应商、角色模型配置页或在线技能更新器。
- 不自动创建 worktree；当前项目规则和用户指令继续优先于技能默认建议。
- 不允许多个写入型实现 Agent 并行修改同一 checkout。
- 不在本次集成中改造为计划级命令授权；项目命令继续使用现有确认框。

## 上游工作流基线

执行顺序遵循官方基本工作流：

1. `brainstorming`：逐项澄清需求、比较方案、分段确认设计并保存规格。
2. `using-git-worktrees`：仅在项目规则或用户明确允许时使用。
3. `writing-plans`：生成带文件路径、代码和验证步骤的实施计划。
4. `subagent-driven-development`：每个任务派发全新实现 Agent，完成后进行规格符合性和代码质量审查。
5. `test-driven-development`：实现 Agent 遵守 RED-GREEN-REFACTOR。
6. `requesting-code-review` 和 `verification-before-completion`：任务间及整分支完成前验证。
7. `finishing-a-development-branch`：测试通过后向用户提供合并、PR、保留或丢弃选项。

上游允许 `executing-plans` 作为无子 Agent 的替代路径；LoopAgent 本次明确实现并优先使用多 Agent 路径。

## 架构

以下是拟新增的宿主模块，文件名是实施计划的边界，不代表本规格阶段已创建源码：

| 模块 | 职责 |
| --- | --- |
| `resources/superpowers/` | 固定 v6.1.1 的官方技能、引用、脚本和 LICENSE；构建时校验内容清单。 |
| `src/extension/superpowers/skillCatalog.ts` | 枚举技能、解析 frontmatter、按安全路径加载正文和相对引用。 |
| `src/extension/superpowers/workflowSupervisor.ts` | 唯一控制器；维护阶段、门禁、计划、Agent 生命周期、checkpoint 和错误升级。 |
| `src/extension/superpowers/agentPool.ts` | 为实现者、审查者和修复者创建独立消息上下文，级联取消并收集结构化结果。 |
| `src/extension/superpowers/workflowStore.ts` | 持久化 workflow checkpoint，校验恢复时的计划、提交和台账一致性。 |
| `src/extension/superpowers/superpowersTypes.ts` | 定义技能、阶段、子 Agent、审查结论和恢复状态类型。 |
| `src/shared/messages.ts` | 增加 `workflowStateChanged` 和 `subagentStateChanged` 事件。 |

Supervisor 通过现有 `AgentRunner` 和 provider 工厂启动子 Agent。子 Agent 使用独立的消息数组和 run ID，但共享经过权限控制的工具注册表。实现 Agent 串行写入；只读调查可并行，且必须声明并发安全。

## 技能路由与宿主适配

官方技能原文不进入永久 system prompt。Supervisor 在会话启动和恢复时注入完整 `using-superpowers`，并向模型提供 14 个技能的名称和描述。模型必须先调用受控的 `loadSkill` 工具加载适用技能；在技能路由完成前，Supervisor 拒绝最终回答、编辑和命令执行。

计划中的受控能力包括：

- `loadSkill(name)`：只读取固定资源根目录内的 `SKILL.md`。
- `loadSkillResource(name, relativePath)`：只读取该技能目录内的直接引用文件。
- `runBundledScript(name, args)`：只启动固定 v6.1.1 资源目录中的官方脚本；Windows 通过现有 Git Bash 执行，缺少 Bash 时明确失败。
- `reportSubagentResult(...)`：实现 Agent 返回 `DONE`、`DONE_WITH_CONCERNS`、`NEEDS_CONTEXT` 或 `BLOCKED`，附报告路径、提交和测试摘要。
- `reportReview(...)`：审查 Agent 分别返回规格符合性、代码质量和 findings。

代码读取、编辑预览、`exploreCode` 和 `runCommand` 继续复用现有工具。官方脚本和技能资源不允许路径穿越，也不在运行时联网下载。

## 工作流状态与门禁

### 设计阶段

1. `BOOTSTRAP`：加载项目规则、技能清单和 `using-superpowers`。
2. `ROUTE`：选择并加载适用技能。
3. `BRAINSTORMING`：一次只问一个问题，提出替代方案，分段展示设计。
4. `DESIGN_APPROVAL`：等待用户批准设计。
5. `WRITE_SPEC`：写入中文规格并自审。
6. `SPEC_REVIEW`：等待用户审阅规格文件。
7. `WRITE_PLAN`：生成中文实施计划。
8. `PLAN_APPROVAL`：用户明确开始后才进入实施。

### 实施阶段

1. 计划预检，发现计划冲突时一次性升级给用户。
2. 为当前任务生成 brief。
3. 派发全新实现 Agent；它负责实现、测试、提交、自审和 report。
4. 派发任务审查 Agent，同时检查规格符合性和代码质量。
5. 有 Critical/Important 问题时派发一个修复 Agent，完成后重新审查；通过后写入 `progress.md`。
6. 所有任务完成后派发一次整分支终审。
7. 通过最终测试、构建和 diff 检查后进入分支收尾选项。

### 恢复与停止

checkpoint 至少记录当前技能、阶段、批准记录、计划路径、任务索引、活动 Agent、run ID、提交基线和取消状态。Stop 会级联取消当前子 Agent，并保留 checkpoint。Resume 先校验计划文件、当前提交和 `progress.md`；不一致时停止自动恢复并请求用户选择。

## 子 Agent 合同

子 Agent 的自然语言最终回答不能直接驱动状态机。实现者和审查者必须通过受控结果工具提交结构化状态。缺字段时最多允许一次纠正回合，仍无效则标记 `BLOCKED`，不能伪装成完成。

同一时间最多一个写入型 Agent。实现者、审查者和修复者均使用当前会话显式选择的模型；第一版不新增角色模型设置，未来有多档模型时再实现成本路由。

## 错误处理与安全

- 官方资源清单、技能或引用缺失：禁用 Superpowers 模式并显示具体路径；普通 ReAct 模式仍可用。
- 模型错误、步数耗尽、脚本非零退出：保存原始错误和 checkpoint，不进行无界自动重试。
- `NEEDS_CONTEXT`：Supervisor 补充 brief 后重新派发；`BLOCKED`：升级模型、拆分任务或请求用户决策。
- 任务审查未同时给出两个结论时不得标记完成。
- 技能和引用路径必须限制在固定资源根目录；仅白名单官方脚本可由宿主免确认启动。
- 项目命令继续经过现有 `runCommand` 确认框；编辑继续经过现有预览边界。
- 取消信号必须从 Supervisor 传递到所有活动子 Agent 和工具调用。

## Webview 事件

新增两类结构化事件：

- `workflowStateChanged`：当前技能、阶段、计划进度和等待用户的原因。
- `subagentStateChanged`：角色、任务、模型、运行状态和结果摘要。

现有聊天正文、reasoning、`agentEvent`、Stop 和 Resume 协议继续复用。界面只增加紧凑的流程时间线，不增加独立管理页面。

## 验证方式

### 自动验证

- 资源完整性：固定 v6.1.1、14 个技能、LICENSE、直接引用和官方脚本全部进入 VSIX。
- `SkillCatalog`：frontmatter 解析、按需加载、引用解析和路径穿越拒绝。
- 路由门禁：未加载适用技能时拒绝回答、编辑和命令；恢复后重新注入 `using-superpowers`。
- 核心状态机：单任务计划跑通实现、审查失败、修复、复审、终审和完成。
- 恢复与并发：Stop/Resume 不重复已通过任务，且不会同时产生两个写 Agent。
- 安全与结构化回报：非白名单脚本、未确认命令、非法结果和错误状态均被拒绝。

### 真实用户路径

在唯一的 Extension Development Host 中使用 `npm run debug:vscode`，从一句功能请求触发 brainstorming，批准设计和计划，观察实现/审查 Agent，停止后恢复一次，并确认最终结果。

### 完成门禁

受影响测试、全量测试、类型检查、构建、VSIX 内容校验和 `git diff --check` 全部通过后，才可声称集成完成。

## 后续事项

计划级命令授权、按角色模型成本路由、官方版本更新器和真正并行的多工作区写入不属于本次第一阶段；只有真实使用数据证明当前权限或吞吐不足时再单独设计。

## Task 7 验证记录（2026-07-22）

- `npm test` 通过：65 个测试文件、445 个用例；`npm run typecheck`、`npm run compile`、`npm run package:vsix` 和 `git diff --check` 均以 0 退出。
- VSIX 为 `.artifacts/loopagent-vscode-0.0.1.vsix`，共 67 个条目；其中含 14 个 `resources/superpowers/skills/*/SKILL.md` 和 `resources/superpowers/LICENSE`。
- 5 个 Superpowers 安全与状态边界测试文件共 24 个用例通过，覆盖资源路径、技能路径穿越、非白名单脚本、无效 Agent 结果、审查结果和 checkpoint 不一致。
- 已启动且仅启动一个 Extension Development Host，并确认 LoopAgent 面板可见、状态为 Ready、存在 Edit/Ask 切换和消息输入框。管理员 VS Code 的 UI 自动化无法点击或填值，因此未提交 edit 请求，也未能实际验证审批、Stop/Resume、写入 Agent 串行和最终工作流事件；该项保持未完成。
