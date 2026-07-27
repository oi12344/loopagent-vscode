# 强制 DynamicGraphEngine 运行时实施计划

> **执行要求：** 实施本计划时使用 `superpowers:executing-plans`，按任务顺序逐项完成、验证并提交。

**目标：** 每次用户请求都由 DeepSeek 创建并执行 `DynamicGraphEngine` 运行时图；删除 Edit/Ask 模式；只读节点可并行，写节点全局串行。

**架构：** 主 Agent 只持有单轮动态图控制工具；`DynamicGraphEngine` 通过现有 `WorkflowOrchestrator` 创建角色化子 Agent。沿用现有图引擎、数据流、反思 resolver、编辑预览/撤销和命令审批，不新增调度器或持久化层。

**技术栈：** TypeScript、React、VS Code Extension API、Vitest、DeepSeek v4 Flash、CDP E2E。

**设计依据：** `docs/superpowers/specs/2026-07-27-forced-dynamic-graph-runtime-design.md`

---

## 任务 1：补齐数据流表达式契约

**文件：** 修改 `src/extension/agent/workflow/dataFlowManager.ts`、`test/dynamicGraphWorkflow.test.ts`

### 步骤 1：写失败测试

在现有数据流测试中覆盖连字符节点 ID、JSON 路径、数组索引、`$global`、字面量、`===`、`!==` 和非法语法：

```typescript
expect(manager.evaluateExpression("read-token.content.items[0]", context)).toBe("alpha");
expect(manager.evaluateExpression("read-token.status === 'completed'", context)).toBe(true);
expect(manager.evaluateExpression("$expected !== null", context)).toBe(true);
expect(() => manager.evaluateExpression("read-token.content + 1", context)).toThrow(/unsupported expression/i);
```

运行 `npx vitest run test/dynamicGraphWorkflow.test.ts`，预期连字符引用和严格比较失败。

### 步骤 2：最小实现并验证

`evaluateExpression()` 先识别顶层严格比较，再分别解析两侧原子表达式。节点正则允许 `[A-Za-z0-9_-]+`；复用现有路径/数组读取。无法识别的非空表达式抛错，已识别但缺值返回 `null`。不得使用 `eval`、`Function` 或新依赖。

```powershell
npx vitest run test/dynamicGraphWorkflow.test.ts
git add src/extension/agent/workflow/dataFlowManager.ts test/dynamicGraphWorkflow.test.ts
git commit -m "fix: complete dynamic graph expressions"
```

---

## 任务 2：实现完整图工具与真实 resolver

**文件：** 修改 `src/extension/agent/dynamicWorkflowTools.ts`；必要时修改 `src/extension/agent/workflow/reflectionResolver.ts`；新增 `test/dynamicWorkflowTools.test.ts`

### 步骤 1：写失败测试

用真实 `DynamicGraphEngine` 和 mock orchestrator 覆盖：

1. `createDynamicGraph` 透传 `dependsOn`、`toolHints`、`timeoutMs`、`inputMapping`、`condition`、`exportTo`、`retry`、`initialGlobalData`、`maxNodes`、`maxDepth`。
2. `fanout` 从源节点 JSON 数组生成有界同构节点，元素通过图级数据映射传入。
3. `conditional` 仅在表达式 truthy 时生成声明节点。
4. `iterative` 复用 `createReflectionResolver()`，在批准文本或 `maxRounds` 到达时停止。

```typescript
expect(graph.nodes.map((node) => node.id)).toEqual(["scan-1", "scan-2"]);
expect(graph.nodes[0]?.inputMapping).toEqual({ item: "$fanout.scan-1" });
expect(iterativeIds).toEqual(["loop-revise-1", "loop-review-1"]);
```

同时覆盖非法角色、重复 ID、未知依赖、超限和非法 resolver JSON。运行 `npx vitest run test/dynamicWorkflowTools.test.ts`，预期 schema 缺字段且 resolver 未注册。

### 步骤 2：补齐 `createDynamicGraph`

直接扩展现有 schema 和输入转换，不增加重复类型层。创建前复用图引擎静态校验，失败时不写入 `activeGraphs`。

### 步骤 3：补齐三类 resolver 与生命周期

- `fanout`：求值必须为数组；ID 为 `${idPrefix}-${index + 1}`；元素写入受限全局数据键，任务文本不得拼接元素内容。
- `conditional`：truthy 返回声明节点，否则返回空数组。
- `iterative`：将 JSON 配置转为现有反思 resolver 参数，批准判定只做普通 `includes()`。
- 所有节点继续受 `maxNodes`、`maxDepth`、重试和取消限制。
- `executeDynamicGraph` 在成功、失败或取消后的 `finally` 释放图；后续访问返回 unknown graph。

### 步骤 4：验证并提交

```powershell
npx vitest run test/dynamicWorkflowTools.test.ts test/dynamicGraphWorkflow.test.ts
git add src/extension/agent/dynamicWorkflowTools.ts test/dynamicWorkflowTools.test.ts
git add src/extension/agent/workflow/reflectionResolver.ts # 仅在实际修改时
git commit -m "feat: expose complete dynamic graph controls"
```

---

## 任务 3：增加 executor 并保证写节点串行

**文件：** 修改 `src/extension/agent/workflow/types.ts`、`roleRegistry.ts`、`src/extension/agent/workflowOrchestrator.ts`、`test/workflow/roleRegistry.test.ts`、`test/workflowOrchestrator.test.ts`

### 步骤 1：写失败测试

```typescript
expect(resolveRole("executor").allowedTools).toEqual([
  "exploreCode", "readFile", "applyEdit", "runCommand",
]);
```

调度测试同时创建两个 executor 和两个 explorer，用 deferred promise 记录峰值，断言 `maxExecutorRunning === 1` 且 `maxReadOnlyRunning >= 2`。运行相关测试，预期未知角色和并发断言失败。

### 步骤 2：最小实现

扩展现有 `SubagentRole` 和 `ROLE_PROFILES`。在 `schedule()` 的现有 `running` 集合旁判断是否已有 executor：有则跳过 executor 候选，完成或取消后继续调度。现有 `maxConcurrentSubagents` 仍控制总并发。

不引入 `toolDispatcher`、队列类或通用锁。

### 步骤 3：验证并提交

```powershell
npx vitest run test/workflow/roleRegistry.test.ts test/workflowOrchestrator.test.ts
git add src/extension/agent/workflow/types.ts src/extension/agent/workflow/roleRegistry.ts src/extension/agent/workflowOrchestrator.ts test/workflow/roleRegistry.test.ts test/workflowOrchestrator.test.ts
git commit -m "feat: serialize dynamic graph executors"
```

---

## 任务 4：强制生产请求走 DynamicGraphEngine

**文件：** 修改 `src/extension/model/providerRegistry.ts`、`test/providerRegistryCodeContext.test.ts`；仅在必调用行为需要调整时修改 `src/extension/agent/reactAgentRunner.ts`、`test/reactAgentRunner.test.ts`

### 步骤 1：写失败测试

捕获主/子 runner 工具与必调用配置：

```typescript
expect(parentToolNames).toEqual([
  "createDynamicGraph", "executeDynamicGraph", "addDynamicResolver",
  "getGraphStatus", "visualizeGraph", "getGraphDebugInfo", "cancelDynamicGraph",
]);
expect(parentRequiredTools).toEqual(["createDynamicGraph", "executeDynamicGraph"]);
expect(executorToolNames).toEqual(expect.arrayContaining(["applyEdit", "runCommand"]));
expect(executorToolNames).not.toContain("createDynamicGraph");
```

模拟模型直答、只创建图、完整创建并执行：前两种失败，最后一种成功。运行 provider/runner 测试确认先失败。

### 步骤 2：替换生产接线

在 `createConfiguredAgentRunner()` 中保留现有读/编辑/命令工具实例和 orchestrator；主 Agent 工具改为 `createDynamicWorkflowTools()`，不再附带直接代码工具或旧工作流工具；固定必调用 `createDynamicGraph`、`executeDynamicGraph`。子 Agent 按角色白名单选工具且不得获得图控制工具。system prompt 只允许建图、执行、汇总。

保留 `enableWorkflowTools: false` 的内部测试语义；正常用户请求必须走强制图路径。

### 步骤 3：验证并提交

```powershell
npx vitest run test/providerRegistryCodeContext.test.ts test/reactAgentRunner.test.ts test/workflowEnd2End.test.ts
git add src/extension/model/providerRegistry.ts test/providerRegistryCodeContext.test.ts
git add src/extension/agent/reactAgentRunner.ts test/reactAgentRunner.test.ts # 仅在实际修改时
git commit -m "feat: force requests through dynamic graphs"
```

---

## 任务 5：删除 Edit/Ask 模式区分

**文件：** 修改 `src/webview/App.tsx`、`src/shared/messages.ts`、`src/shared/chatTypes.ts`、`src/extension/agentRunner.ts`、`src/extension.ts`、`test/App.test.tsx`、`test/reactAgentRunner.test.ts`、`test/extension/conversation/conversationManager.test.ts`、`test/extension/conversation/persistentConversationStore.test.ts`

### 步骤 1：先改测试

删除模式选择测试，改为断言无 Mode 分组且提交消息无 `mode`：

```typescript
expect(screen.queryByRole("group", { name: "Mode" })).not.toBeInTheDocument();
expect(postMessage).toHaveBeenCalledWith(expect.not.objectContaining({ mode: expect.anything() }));
```

恢复测试写入带 `mode: "edit"` 的 version 1 checkpoint，断言仍可恢复；新 checkpoint 断言无 `mode`。运行上述四个测试文件，确认先失败。

### 步骤 2：删除运行时模式

删除 `TaskMode`、webview 状态/按钮、消息字段、run options/active run 字段及默认值。`InterruptedRunCheckpoint` 保留可选旧字段仅作反序列化兼容；新 checkpoint 不写，恢复时忽略。

不改变 thinking、审批、编辑预览/撤销或 Stop/Resume。

### 步骤 3：验证并提交

```powershell
npx vitest run test/App.test.tsx test/reactAgentRunner.test.ts test/extension/conversation/conversationManager.test.ts test/extension/conversation/persistentConversationStore.test.ts
git add src/webview/App.tsx src/shared/messages.ts src/shared/chatTypes.ts src/extension/agentRunner.ts src/extension.ts test/App.test.tsx test/reactAgentRunner.test.ts test/extension/conversation/conversationManager.test.ts test/extension/conversation/persistentConversationStore.test.ts
git commit -m "refactor: remove task mode distinction"
```

---

## 任务 6：恢复当前类型检查基线

**文件：** 修改 `src/extension/agent/toolDispatcher.ts`

### 步骤 1：确认和修复既有错误

运行 `npm run typecheck`，确认剩余错误来自该未接线文件：并发安全调用缺参数、`ReactAgentToolRequest` 缺字段、不可达重复返回引用未定义变量。

补齐请求 `id`、`rawArguments`；未知并发安全默认 `false`；保留完整 dispatcher 返回并删除其后的不可达重复 stub。不得注册该文件或改变生产调度。

### 步骤 2：验证并提交

```powershell
npm run typecheck
git add src/extension/agent/toolDispatcher.ts
git commit -m "fix: restore tool dispatcher type safety"
```

---

## 任务 7：真实 DeepSeek E2E、文档与最终验证

**文件：** 修改 `scripts/codeExplorationE2e.js`、`scripts/run-code-exploration-e2e.mjs`、`test/codeExplorationE2e.test.ts`、`docs/development.md`；新增 `docs/superpowers/guides/dynamic-graph-runtime.md`；更新本计划完成状态

### 步骤 1：收紧 E2E 判定

复杂问题保持为面向项目行为的问题，不泄露内部符号。评估器除源码证据外，检查 process 中成功调用 `createDynamicGraph`、`executeDynamicGraph`，至少两个只读节点运行区间重叠，且 reviewer 在其后完成：

```typescript
expect(evaluation.toolCalls).toEqual(expect.arrayContaining([
  "createDynamicGraph", "executeDynamicGraph",
]));
expect(evaluation.parallelReadOnlyNodes).toBeGreaterThanOrEqual(2);
expect(evaluation.reviewerCompleted).toBe(true);
```

先运行 `npx vitest run test/codeExplorationE2e.test.ts` 确认失败，再只扩展现有 CDP process 采集和判定，不新增 runner 或浏览器框架。

### 步骤 2：静态验证

```powershell
npm run compile
npm run typecheck
npm test
git diff --check
```

全部成功后才进入真实 E2E。

### 步骤 3：同一 Extension Host 真实验证

确认 9333 只有一个调试目标；没有时仅运行一次 `npm run debug:vscode`。在同一窗口刷新后运行：

```powershell
npm run test:e2e:code-exploration
```

验收：DeepSeek v4 Flash 完成复杂项目问题；process 含图创建、节点状态、图完成和两项必调用；两个只读节点并行，reviewer 后置；只读 E2E 不改业务文件。API token 不得写入仓库、脚本、日志或文档。

### 步骤 4：文档、清理、复验和提交

中文记录统一入口、角色权限、executor 串行、验证命令和实际 E2E 结果；关联设计、源码和测试。删除本次临时文件，不处理用户原有未跟踪文件。重复步骤 2 后执行：

```powershell
git status --short
git add scripts/codeExplorationE2e.js scripts/run-code-exploration-e2e.mjs test/codeExplorationE2e.test.ts docs/development.md docs/superpowers/guides/dynamic-graph-runtime.md docs/superpowers/plans/2026-07-27-forced-dynamic-graph-runtime-plan.md
git commit -m "test: verify forced dynamic graph runtime"
```

最后审查 `git diff HEAD~7..HEAD`：主 Agent 无直接文件/命令工具，子 Agent 无图控制工具，旧 checkpoint 兼容，无 token 和临时调试代码。

## 完成记录（2026-07-27）

- 任务 1 至任务 6 已完成并分别提交；生产请求默认强制进入 `DynamicGraphEngine`，Edit/Ask 模式已删除。
- 真实 E2E 暴露并修复两个运行时问题：角色白名单被二次裁剪成单工具，以及 60 秒节点配置被默认 30 秒上限截断。
- `npm run test:e2e:code-exploration` 使用 DeepSeek v4 Flash 通过：单张三节点图调用 `createDynamicGraph`、`executeDynamicGraph`，两个只读节点并发，双依赖 reviewer 后置完成，回答命中 4 个关键函数和 12 个真实源码路径。
- 最终审查补齐：重试退避可取消、resolver 批量扩图原子验证、建图结果包含角色/依赖摘要、失效 `graphId` 明确提示重建。
- 同一 Extension Development Host 完成验证；截图保存在 `.artifacts/code-exploration-e2e.png`。密钥未写入仓库、脚本、日志或文档。
