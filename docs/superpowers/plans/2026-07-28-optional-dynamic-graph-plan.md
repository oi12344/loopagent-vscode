# 按需动态图计划

## 背景

2026-07-27 的强制动态图运行时设计（`forced-dynamic-graph-runtime-design.md`）要求主 Agent 每次请求都先建图并执行，不持有任何直接工具。这个决策当时是为了统一入口、去掉 Edit/Ask 模式，但没有区分任务规模：一句话问答和多路并行探索走的是同一条强制建图路径。

Anthropic 官方指南给出了相反的默认顺序：

- 《Building Effective AI Agents》：优先用最简单的方案，只在确有需要时才增加复杂度；workflow 提供确定性，agent 提供灵活性，二者按需选择，不是默认叠加。
- 《When to use multi-agent systems (and when not to)》：多 Agent 编排只在三种场景下才稳定优于单 Agent——context 需要隔离/并行化、任务本身涉及多个独立活动面、单 Agent 处理不了的信息量级。单一、定义清晰、证据能在一个上下文内装下的任务不该引入编排。

本计划让主 Agent 按任务形状自行判断是否建图，而不是无条件强制。

## 目标

- 主 Agent 同时持有直接工具（`exploreCode`、`readFile`、`applyEdit`、`runCommand`）和 `runDynamicGraph`。
- 系统提示给出判断标准：单一、定义清晰、单上下文够用的任务直接用直接工具；需要多路独立并行探索加汇总复核，或超出单次工具调用预算的任务才建图。
- 保留最低限度的证据门禁：给最终答案前必须至少成功调用过一个真实工具（直接工具或 `runDynamicGraph` 均可），防止模型在零证据下直接回答。

## 非目标

- 不改 `DynamicGraphEngine`、`WorkflowOrchestrator`、角色权限或调度语义。
- 不改子 Agent（graph 节点）的工具集或系统提示；子 Agent 仍不持有 `runDynamicGraph`，不能创建嵌套工作流。
- 不改 `enableWorkflowTools === false` 分支（测试/其他宿主用的纯直接工具模式）。
- 不回改已归档的 2026-07-27 强制建图设计/计划文档（历史记录）。

## 实现

### 1. `src/extension/agent/reactAgentRunner.ts`

新增 `requiredAnyOfToolNames?: string[]` 选项，与既有的 `requiredToolNames`（全部满足）语义独立、可同时使用：

- `getMissingRequirements(requiredToolNames, requiredAnyOfToolNames, successfulTools)` 替代原 `getMissingRequiredTools`，返回全满足缺口 + `requiredAnyOfToolNames` 未被任一满足时追加的 `one of [...]` 提示。
- 三处判定分支（`toolChoice` 计算、`final` 结果拦截、`isFinalAnswerStep` 拦截）统一改用这个函数。

### 2. `src/extension/model/providerRegistry.ts`

- 把原来重复的系统提示文本拆成 `DIRECT_TOOL_GUIDANCE`（直接工具用法准则）和 `GRAPH_TOOL_GUIDANCE`（何时才该建图、图内部约束），`REACT_SYSTEM_PROMPT` 只用前者，新的 `AGENT_SYSTEM_PROMPT` 两者都用。
- 默认分支（`enableWorkflowTools !== false`）的主 Agent 工具集从仅 `runDynamicGraph` 改为 `[...parentTools, ...createDynamicWorkflowTools(...)]`。
- `createParentRunner` 新增 `requiredAnyOfToolNames` 形参；默认分支传入完整工具名列表，不再传全满足的 `requiredToolNames`。

### 3. 测试

- `test/reactAgentRunner.test.ts`：新增两个用例覆盖 `requiredAnyOfToolNames` 的拦截和放行。
- `test/providerRegistryCodeContext.test.ts`：
  - 原"forces the parent runner to use only dynamic graph controls"改写为验证工具集包含直接工具 + `runDynamicGraph`，且零工具调用时被 OR 门禁拦下。
  - 新增用例验证调用一次直接工具后可以不建图直接给出最终答案。
  - "runs workflow subagents..."用例的父轮工具名断言更新为完整工具集。

### 4. 文档

- `docs/superpowers/guides/dynamic-graph-runtime.md`：更新为"主 Agent 同时持有直接工具和图工具，按需建图"，门禁描述从"必须调用 runDynamicGraph"改为"至少调用一个真实工具"。

## 验收

```powershell
npm run compile
npm run typecheck
npm test
git diff --check
```

`npm run typecheck` 目前有两处与本次改动无关的预存错误（`src/extension.ts:260` 和 `src/extension/vision/visionAnalysisTool.ts`，均属 `c980464 refactor: remove task modes` 引入，未在本计划改动范围内）；`npm test` 中 `test/extensionWorkspaceIntelligence.test.ts` 的两个失败同源，同样与本次改动无关。本次改动涉及的三个测试文件（`reactAgentRunner.test.ts`、`providerRegistryCodeContext.test.ts`、`dynamicWorkflowTools.test.ts`）全部通过。

真实 DeepSeek E2E 未在本次执行——`scripts/codeExplorationE2e.js` 的判定问题本身就要求"唯一一张图，两个并行只读节点 + 一个 reviewer"，属于多路并行场景，符合新判据下模型仍应建图的情形，无需改动判定逻辑。
