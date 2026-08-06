# 协调者统一工具调用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主智能体和子智能体的工具调用统一经过本次运行的 `WorkflowOrchestrator`，并保持长期工具资源由 Provider 释放。

**Architecture:** 在 `toolRegistry.ts` 定义可注入的 `ToolInvoker`。`ReactAgentRunner` 通过可选 invoker 执行工具，默认继续使用本地 registry；`WorkflowOrchestrator` 绑定每个 runner 的工具集合、合并取消信号并跟踪活动调用。Provider 将协调者 invoker 同时注入主 runner 和子 runner，角色路由后的工具集合仍是权限边界。

**Tech Stack:** TypeScript, Vitest, VS Code extension host abstractions.

---

### Task 1: 为注入式调用入口写失败测试

**Files:**
- Modify: `test/reactAgentRunner.test.ts`
- Modify: `test/workflowOrchestrator.test.ts`

- [x] **Step 1: 写 runner 注入调用失败测试**

增加一个测试工具，其 `invoke` 抛出明确错误；注入 `invokeTool` 返回成功 observation，断言 runner 输出成功结果且工具自身没有被直接调用。

- [x] **Step 2: 写 orchestrator 统一调用失败测试**

增加成功字符串规范化、集合外工具拒绝和取消活动调用的测试。测试通过协调者公开调用入口验证行为，不断言私有集合结构。

- [x] **Step 3: 运行定向测试确认 RED**

运行：

```text
npm test -- test/reactAgentRunner.test.ts test/workflowOrchestrator.test.ts
```

预期：新增测试因 `invokeTool` 类型/接口尚不存在而失败，既有测试保持可执行。

### Task 2: 增加可注入调用契约并接入 Runner

**Files:**
- Modify: `src/extension/agent/toolRegistry.ts`
- Modify: `src/extension/agent/reactAgentRunner.ts`

- [x] **Step 1: 定义 `ToolInvoker`**

把现有 registry 的请求签名抽成导出类型：

```ts
export type ToolInvoker = (
  request: ReactAgentToolRequest,
  signal: AbortSignal,
) => Promise<ReactAgentToolResult>;
```

- [x] **Step 2: 保留本地 registry 兼容默认值**

实现 `createToolInvoker(tools)`，继续复用现有名称查找和字符串结果规范化；`createToolRegistry` 保留为兼容包装。

- [x] **Step 3: 接入 `createReactAgentRunner`**

增加可选 `invokeTool?: ToolInvoker`。工具请求执行时优先调用注入入口，否则使用 `createToolInvoker(tools)`；未知工具、参数解析错误、重复调用和并发批次逻辑保持不变。

- [x] **Step 4: 运行 runner 测试确认 GREEN**

运行：

```text
npm test -- test/reactAgentRunner.test.ts
```

预期：注入入口测试和既有 runner 测试全部通过。

### Task 3: 让 WorkflowOrchestrator 成为统一调用入口

**Files:**
- Modify: `src/extension/agent/workflowOrchestrator.ts`
- Modify: `src/extension/agent/workflow/types.ts`
- Modify: `test/workflowOrchestrator.test.ts`

- [x] **Step 1: 扩展协调者类型**

在 `WorkflowOrchestrator` 上暴露 `invokeTool(tools, request, signal)`，在 `SubagentRunnerFactoryInput` 上传递绑定当前子工具集合的 `invokeTool`。

- [x] **Step 2: 实现统一调用与活动调用跟踪**

协调者按传入工具集合查找工具，创建内部 `AbortController` 合并 runner 信号，规范化字符串结果，用 `Set<AbortController>` 记录调用，并在成功、失败或异常的 `then`/`catch` 清理；不得添加长期资源 `dispose()`。

- [x] **Step 3: 将子 runner 绑定到协调者入口**

`start()` 创建子 runner 时传入协调者 invoker；`createSubagent` 仍先通过角色白名单和 `selectTools` 生成子工具集合。

- [x] **Step 4: 运行协调者测试确认 GREEN**

运行：

```text
npm test -- test/workflowOrchestrator.test.ts
```

预期：调用入口、权限拒绝、活动调用清理和原有 DAG/并发测试全部通过。

### Task 4: 接通主 runner 与生产子 runner

**Files:**
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `test/providerRegistryCodeContext.test.ts`

- [x] **Step 1: 主 runner 注入协调者 invoker**

在工作流模式下创建 `parentRunner` 时传入绑定父工具集合的 `invokeTool: (request, signal) => orchestrator.invokeTool(parentToolsWithGraph, request, signal)`；工具集合保持 `parentTools + graphTools`。

- [x] **Step 2: 子 runner 复用同一入口**

在 `createRunner` 回调中把 `invokeTool` 传给 `createReactAgentRunner`，工具集合为角色路由后的 `childTools`。

- [x] **Step 3: 保留结束与取消顺序**

继续在父 runner `finally` 中调用 `orchestrator.cancelAll()`、取消事件订阅并关闭事件队列；不调用长期服务 `dispose()`。不在 `finally` 强制等待忽略取消信号的工具，避免退出路径被第三方调用永久阻塞。

- [x] **Step 4: 运行生产接线测试确认 GREEN**

运行：

```text
npm test -- test/providerRegistryCodeContext.test.ts test/workflowEnd2End.test.ts
```

预期：主/子 runner 均使用协调者入口，既有工具路由和工作流事件不回归。

### Task 5: 集中验证与文档收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-08-04-centralized-tool-lifecycle-design.md`
- Modify: `docs/superpowers/plans/2026-08-04-centralized-tool-lifecycle-plan.md`

- [x] **Step 1: 更新设计和计划完成记录**

记录实际 API、测试结果和任何与初始设计不同的行为。

- [x] **Step 2: 运行全量验证**

运行：

```text
npm test
npm run typecheck
npm run compile
git diff --check
```

- [x] **Step 3: 审查 diff**

确认没有长期资源错误释放、绕过协调者的生产调用路径、临时调试输出或无关文件变更。

## 实施结果

- `ToolInvoker` 已注入 `ReactAgentRunner`；未注入时继续使用本地 registry。
- 主 runner 和子 runner 在工作流模式下都经由同一个 `WorkflowOrchestrator` 调用入口。
- 协调者为每次调用创建运行级 `AbortController`，`cancelAll()` 会中止活动工具调用；长期资源仍由 Provider 释放。
- 定向验证：4 个测试文件、78 个测试通过。
- 全量验证：908 个通过、3 个跳过、6 个既有基线失败；失败位于 Webview、Java/code review、spool 和 Windows 进程清理测试。
- `npm run compile` 和 `git diff --check` 通过；`npm run typecheck` 仍受既有 `codeReview`、Java AST 和 Webview 类型错误阻塞，本次修改文件没有新增类型错误。
