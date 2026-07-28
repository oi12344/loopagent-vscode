# 动态图运行时指南

## 统一入口

Webview 的每次用户请求都经 `src/extension.ts` 进入 `createConfiguredAgentRunner()`。默认生产 runner 的主 Agent 同时持有直接工具和一个图控制工具：

- 直接工具：`exploreCode`、`readFile`、`applyEdit`、`runCommand`（按依赖注入情况可用）
- `runDynamicGraph` —— 单次调用内建图、注册 resolver、执行并返回全部节点结果

主 Agent 给出最终答案前必须至少成功调用过其中任意一个真实工具（`requiredAnyOfToolNames` 门禁），而不是必须调用 `runDynamicGraph`。这个门禁只防止模型在零证据下直接作答，不强制建图。

系统提示要求模型按任务形状自行判断：单一、定义清晰、证据能在一个上下文内装下的任务（例如一次调用链问答、单文件编辑）直接用直接工具处理；只有当任务真正需要多路独立、可并行的探索，或超出单次工具调用预算时，才调用 `runDynamicGraph`。默认图只包含相互独立的只读分析节点，图执行完成后由父 Agent 直接核对并汇总结构化结果，不额外创建 reviewer。只有用户明确要求独立审查时才添加 reviewer。这一判断依据 Anthropic《Building Effective AI Agents》和《When to use multi-agent systems》的指导：默认用最简单的方案，只在确有需要时才引入 workflow/多 Agent 编排。

建图与执行合并为一次调用是有意的：两者之间没有需要模型介入的决策，`graphId` 只会被原样传回，那次模型往返纯属浪费。合并后 `graphId` 概念消失，图的生命周期收敛到单次 `invoke()` 内，"复用已释放图"这一整类错误路径不再存在。

## 角色与调度

`DynamicGraphEngine` 按依赖关系把就绪节点交给 `WorkflowOrchestrator`：

| 角色 | 可用工具 | 用途 |
| --- | --- | --- |
| `explorer` | `exploreCode`、`readFile` | 定位源码、符号和调用链 |
| `planner` | `exploreCode`、`readFile` | 基于源码拆解步骤 |
| `reviewer` | `exploreCode`、`readFile` | 核对结果和风险 |
| `executor` | `exploreCode`、`readFile`、`applyEdit`、`runCommand` | 修改与验证 |

有效 `toolHints` 可以进一步缩小角色工具集；未提供或提示无效时保留该角色的完整白名单。子 Agent 不持有图控制工具，不能创建嵌套工作流。

无依赖的只读节点可并发。涉及写入的 `applyEdit` 仍经编辑预览和撤销链路；`runCommand` 仍需逐命令审批，并受工作区根目录限制。executor 的写操作由现有工具约束串行化，不引入第二套调度器。子节点默认最长运行 60 秒；显式 `timeoutMs` 仍受该上限限制。

`runDynamicGraph` 的结果固定包含 `nodes`（节点 ID、角色、依赖摘要，供运行观测与 E2E 核对）、`totalNodes`、`statusCounts`、`completedNodes`、`results`、`executionOrder` 和 `resolverFailures`。resolver 批量扩图会先整体验证，任一节点非法时整批不落图。重试退避可被 Stop 立即中断。

可选入参 `include` 接受 `visualization`、`debug`、`mermaid`，按需把对应观测数据折叠进同一个结果；不指定时这些字段完全缺席，不占 token。

`dependsOn` 只控制调度，不会自动传递上游输出。用户明确要求独立审查且 reviewer 需要聚合多个分析节点时，必须为每个依赖设置 `inputMapping`，例如 `{ "webview": "chain-webview-to-host.content", "host": "chain-host-to-deepseek.content" }`；否则 reviewer 会重新读取源码并可能触发 60 秒节点超时。

所有节点均未完成（`statusCounts.completed` 为 0）时 `runDynamicGraph` 抛错而非返回空结果：这种图不携带任何证据，若按成功返回会满足 `requiredAnyOfToolNames` 门禁，让模型在零证据下作答。用户取消（存在 `cancelled` 节点）是例外，此时运行本就要结束，部分结果就是全部所得。

## 验证

静态和回归验证：

```powershell
npm run compile
npm run typecheck
npm test
git diff --check
```

真实 DeepSeek 验证必须复用唯一的 Extension Development Host：

```powershell
npm run debug:vscode
npm run test:e2e:code-exploration
```

2026-07-27 的真实 E2E 历史基线包含两个无依赖只读节点和一个双依赖 reviewer。2026-07-28 起的当前验收改为：单张图恰好包含两个无依赖只读节点，两个节点实际并发，图中不存在 reviewer，最终答案由父 Agent 汇总并命中真实源码证据。截图仍输出到 `.artifacts/code-exploration-e2e.png`。

## 关联文件

- 设计：`docs/superpowers/specs/2026-07-27-forced-dynamic-graph-runtime-design.md`（历史设计，"强制建图"部分已被下方计划取代）
- 计划：`docs/superpowers/plans/2026-07-27-forced-dynamic-graph-runtime-plan.md`、`docs/superpowers/plans/2026-07-28-optional-dynamic-graph-plan.md`
- 生产装配：`src/extension/model/providerRegistry.ts`
- 图工具：`src/extension/agent/dynamicWorkflowTools.ts`
- 图执行：`src/extension/agent/workflow/dynamicGraphEngine.ts`
- 角色与调度：`src/extension/agent/workflow/roleRegistry.ts`、`src/extension/agent/workflowOrchestrator.ts`
- E2E：`scripts/run-code-exploration-e2e.mjs`、`scripts/codeExplorationE2e.js`
