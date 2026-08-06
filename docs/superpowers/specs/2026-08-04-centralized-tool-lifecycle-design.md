# 协调者统一工具调用与运行级生命周期设计

## 目标

让主智能体和子智能体的工具调用都经过同一个 `WorkflowOrchestrator` 调用入口，由协调者统一控制本次运行的工具可见性、调用边界、活动调用跟踪和取消语义，同时保留 Provider 对长期资源的所有权。

## 范围

- 主智能体与子智能体使用同一个运行级工具调用函数。
- 协调者在调用前校验工具是否属于当前 runner 的工具集合，在调用后统一规范化结果并清理活动调用记录。
- `AbortSignal` 继续作为工具停止信号；协调者取消子智能体时，子 runner 的信号传递给工具。
- 保留现有角色白名单和 `toolHints` 路由，不允许协调者扩大子智能体权限。
- 保留 Provider 对 `WorkspaceIntelligence`、`EditPreviewService`、视觉服务等长期资源的创建和 `dispose()` 所有权。

## 非目标

- 不把长期服务改成每个工作流创建和销毁。
- 不新增工具级 `onStart`、`onEnd` 或 `dispose` 生命周期接口。
- 不重写模型回合、工具批次顺序或 `isConcurrencySafe` 判定；这些仍由 `ReactAgentRunner` 编排。
- 不改变 `ReactAgentTool` 的公开工具契约，旧的直接 runner 调用继续使用本地 registry 作为兼容默认值。

## 设计

### 调用边界

新增绑定工具集合的 `ToolInvoker` 类型，接受请求和取消信号，返回规范化的 `ReactAgentToolResult`。`ReactAgentRunner` 增加可选 `invokeTool`；未注入时继续使用现有 `createToolRegistry(tools)`。

`WorkflowOrchestrator` 增加 `invokeTool(tools, request, signal)`。该方法负责：

1. 在传入工具集合中按名称查找工具，找不到时返回原有未知工具错误。
2. 调用工具并把字符串结果规范化为 `{ content, evidence: [] }`。
3. 为每次调用创建运行级 `AbortController`，同时监听 runner 的 `AbortSignal`；`cancelAll()` 会中止仍在协调者中的活动调用。
4. 记录活动调用，调用结束、失败或抛出异常时移除记录。
5. 不创建或销毁长期工具资源。

### 生产接线

`providerRegistry.ts` 创建本次请求的协调者后：

- 主 runner 使用 `orchestrator.invokeTool`，工具集合为 `parentTools + graphTools`。
- 子 runner factory 使用同一个协调者调用入口，工具集合为角色路由后的子工具集合。
- Provider 的 `finally` 仍先取消协调者，再关闭事件队列；扩展退出时继续由 Chat Provider 的 `dispose()` 释放长期服务。

### 生命周期与失败语义

- 工具可用范围在 runner 创建时固定；协调者不能通过调用入口获得集合之外的工具。
- runner 在调用前仍负责解析错误、重复调用拦截和并发批次；协调者负责实际 invoke 的统一入口和运行级取消信号。
- 调用期间收到 runner 或协调者取消信号时，由具体工具决定如何响应；协调者不吞掉工具的取消异常。
- 协调者不提供长期资源 `dispose()`，避免一个工作流结束时关闭仍被其他任务复用的服务。

## 验证方式

- `reactAgentRunner.test.ts`：注入 `invokeTool` 后断言 runner 不直接调用工具对象，而是通过注入入口取得 observation；未注入时保留原有行为。
- `workflowOrchestrator.test.ts`：断言协调者统一规范化字符串结果、拒绝集合外工具，并在成功与失败后清理活动调用。
- `providerRegistry` 相关测试：断言主 runner 与子 runner 都收到同一个协调者调用入口。
- 运行受影响 Vitest、`npm run typecheck`、`npm run compile` 和 `git diff --check`。

## 实施状态

已实现。工作流模式下主 runner 与子 runner 都使用协调者调用入口；协调者仅管理本次运行的活动调用和取消信号，不释放 Provider 持有的长期资源。定向测试 78 个通过，编译和差异检查通过；全量测试与类型检查中的既有基线失败已记录在实施计划中。
