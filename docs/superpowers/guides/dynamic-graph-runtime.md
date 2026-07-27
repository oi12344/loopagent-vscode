# 强制动态图运行时指南

## 统一入口

Webview 的每次用户请求都经 `src/extension.ts` 进入 `createConfiguredAgentRunner()`。默认生产 runner 的主 Agent 只能使用以下七个图控制工具：

- `createDynamicGraph`
- `executeDynamicGraph`
- `addDynamicResolver`
- `getGraphStatus`
- `cancelDynamicGraph`
- `visualizeGraph`
- `getGraphDebugInfo`

其中 `createDynamicGraph` 和 `executeDynamicGraph` 必须至少成功一次。主 Agent 不持有 `exploreCode`、`readFile`、`applyEdit` 或 `runCommand`，也不能绕过运行时图直接回答仓库问题。

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

`createDynamicGraph` 返回节点 ID、角色和依赖摘要，供运行观测与 E2E 核对。resolver 批量扩图会先整体验证，任一节点非法时整批不落图。重试退避可被 Stop 立即中断。

`dependsOn` 只控制调度，不会自动传递上游输出。reviewer 聚合多个分析节点时，必须为每个依赖设置 `inputMapping`，例如 `{ "webview": "chain-webview-to-host.content", "host": "chain-host-to-deepseek.content" }`；否则 reviewer 会重新读取源码并可能触发 60 秒节点超时。

`executeDynamicGraph` 返回节点结果、执行顺序和 resolver 失败信息，并在成功、失败或取消后释放该图。释放或恢复会话后不得复用旧 `graphId`；错误会明确要求重新调用 `createDynamicGraph`。

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

2026-07-27 的真实 E2E 使用 DeepSeek v4 Flash，通过结果为：单张图恰好包含两个无依赖只读节点和一个双依赖 reviewer；`createDynamicGraph`、`executeDynamicGraph` 均成功；两个只读节点并发；reviewer 后置完成；最终回答命中 4 个关键函数和 12 个真实源码路径。截图位于 `.artifacts/code-exploration-e2e.png`。

## 关联文件

- 设计：`docs/superpowers/specs/2026-07-27-forced-dynamic-graph-runtime-design.md`
- 计划：`docs/superpowers/plans/2026-07-27-forced-dynamic-graph-runtime-plan.md`
- 生产装配：`src/extension/model/providerRegistry.ts`
- 图工具：`src/extension/agent/dynamicWorkflowTools.ts`
- 图执行：`src/extension/agent/workflow/dynamicGraphEngine.ts`
- 角色与调度：`src/extension/agent/workflow/roleRegistry.ts`、`src/extension/agent/workflowOrchestrator.ts`
- E2E：`scripts/run-code-exploration-e2e.mjs`、`scripts/codeExplorationE2e.js`
