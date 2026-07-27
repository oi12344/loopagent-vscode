# 强制动态图运行时设计规格

## 目标

将 `DynamicGraphEngine` 接入 LoopAgent 的真实 DeepSeek/ReAct 运行链路。每次用户请求都必须先创建并执行运行时图，不再保留 Edit/Ask 模式，也不允许主 Agent 绕过图直接读取、修改或回答。

成功结果：

- 简单问题创建至少一个节点，复杂任务按依赖关系创建多个节点。
- 主 Agent 只能规划、控制和汇总图，实际工作由图节点完成。
- 图节点可按角色读取、规划、复核、编辑和执行命令。
- 编辑保留文件级预览与撤销，命令继续逐次审批且只能在工作区内执行。
- 条件、数据映射、重试、全局数据、动态 resolver、取消和可视化均可从生产工具调用到达。

## 非目标

- 不接入未完成的 `toolDispatcher.ts` 调度架构。
- 不允许子 Agent 创建嵌套工作流。
- 不引入任意 JavaScript、函数序列化或动态代码执行。
- 不增加图持久化、时间旅行或跨进程恢复。
- 不允许并行写入工作区。

## 当前差距

生产链路目前在 `providerRegistry.ts` 中只注册 `createWorkflowTools()`，主 Agent 可以调用 `spawnSubagent`、`waitForSubagents`、`cancelSubagent`，但不会创建 `DynamicGraphEngine`。

`createDynamicWorkflowTools()` 尚无生产调用方，并存在以下契约缺口：

- `createDynamicGraph` 未暴露 `dependsOn`、`exportTo`、`retry` 和 `initialGlobalData`。
- `addDynamicResolver` 仅返回成功标记，没有注册 resolver。
- 角色只有 `explorer`、`reviewer`、`planner`，全部只读。
- 数据流表达式不支持带连字符的节点 ID，也不支持 `===`、`!==`。
- Webview、共享消息、运行请求和中断 checkpoint 仍携带 Edit/Ask 模式。

## 总体架构

```text
统一聊天入口
    |
    v
DeepSeek 图控制器（仅动态图控制工具）
    |
    | createDynamicGraph -> addDynamicResolver* -> executeDynamicGraph
    v
DynamicGraphEngine
    |
    +-- explorer / planner / reviewer：只读工具，可并行
    |
    +-- executor：读取、编辑、命令工具，只能串行
    v
图结果与执行证据
    |
    v
DeepSeek 最终汇总
```

主 Agent 的工具集合不包含 `readFile`、`exploreCode`、`applyEdit`、`runCommand` 和旧工作流工具。它只能操作本轮作用域内的动态图。运行请求要求 `createDynamicGraph` 和 `executeDynamicGraph` 均至少成功一次；缺失任一调用时不得生成最终答案。

## 统一运行入口

### Webview

- 删除 `taskMode` 状态和 Edit/Ask 按钮。
- `submitTask()` 不再接收或发送模式。
- 建议任务与普通提交走同一入口。
- 保留模型、思考开关、历史记录、Stop、命令审批和编辑撤销界面。

### 消息与会话

- 从新建和继续会话消息中删除 `mode`。
- 从 `AgentRunRequest`、`StartAgentRunOptions` 和活动运行信息中删除 `mode`。
- 新 checkpoint 不再写入 `mode`。
- 读取旧 checkpoint 时允许存在 `mode`，但运行时忽略该字段，确保历史中断会话仍可恢复。

## 角色与权限

角色集合扩展为：

| 角色 | 职责 | 可用工具 |
|---|---|---|
| `explorer` | 定位代码与收集证据 | `exploreCode`, `readFile` |
| `planner` | 基于现状拆解执行步骤 | `exploreCode`, `readFile` |
| `reviewer` | 检查缺陷、回归和证据 | `exploreCode`, `readFile` |
| `executor` | 实施变更并验证 | `exploreCode`, `readFile`, `applyEdit`, `runCommand` |

子 Agent 不获得动态图控制工具、记忆写工具或工作区外访问能力。

`WorkflowOrchestrator` 保持只读节点的现有并发上限，同时增加 executor 闸门：任意时刻最多运行一个 `executor`。模型仍必须通过 `dependsOn` 表达业务顺序；串行闸门只是防止错误图造成并行写冲突。

## 动态图工具契约

### `createDynamicGraph`

输入包含：

```typescript
type CreateDynamicGraphInput = {
  initialNodes: Array<{
    id: string;
    task: string;
    role?: "explorer" | "planner" | "reviewer" | "executor";
    dependsOn?: string[];
    toolHints?: string[];
    timeoutMs?: number;
    inputMapping?: Record<string, string>;
    condition?: {
      type: "always" | "onSuccess" | "onFailure" | "custom";
      expression?: string;
    };
    exportTo?: string;
    retry?: { maxAttempts: number; backoffMs?: number };
  }>;
  initialGlobalData?: Record<string, DataFlowValue>;
  maxNodes?: number;
  maxDepth?: number;
};
```

创建阶段校验唯一 ID、未知依赖、静态循环、角色、条件、重试和资源上限。图定义不合法时不创建活动图。

`dependsOn` 只表达执行顺序，不自动传递上游结果。需要聚合分析结果的 reviewer 必须为每个依赖配置 `inputMapping`，使用 `<node-id>.content` 将结果作为受信边界内的数据输入；系统提示必须明确这一约束，避免 reviewer 因重新探索而耗尽节点超时。

### `addDynamicResolver`

resolver 只接受纯 JSON 配置，并真实写入对应活动图的 resolver Map。

#### `fanout`

从源节点结果中的 JSON 数组生成同构节点：

- `itemsExpression`：返回数组的数据流表达式。
- `idPrefix`：生成 `${idPrefix}-${index + 1}`。
- `task`、`role`、`toolHints`、`retry`：生成节点的共同配置。
- `itemInputKey`：数组元素写入图级数据，再通过 `inputMapping` 注入节点。

数组元素只进入受限的不可信数据块，不拼接到任务指令。

#### `conditional`

- `expression`：使用数据流表达式求值。
- `nodes`：表达式为 truthy 时生成的完整节点配置数组。

表达式为 falsy 时生成空数组；表达式语法错误时发出 `ResolverFailed`，不静默继续。

#### `iterative`

基于现有 `createReflectionResolver()` 展开无回边的执行/复核链：

- `maxRounds`：最大轮数。
- `approvalText`：review 内容包含该普通文本时结束。
- `reviseTask`、`reviewTask`：各轮任务模板，不插入未经隔离的模型输出。
- `idPrefix`、`reviseRole`、`reviewRole`：生成节点配置。

迭代同时受 `maxRounds`、`maxDepth` 和 `maxNodes` 限制。

### 其他控制工具

`executeDynamicGraph`、`getGraphStatus`、`visualizeGraph`、`getGraphDebugInfo`、`cancelDynamicGraph` 保留。所有活动图仅在单次运行中有效，运行完成、失败或取消后释放。

## 数据流表达式

受支持语法：

- 字面量：字符串、数字、布尔值、`null`
- 节点字段：`node-id.content`、`node-id.status`、`node-id.error`
- JSON 路径：`node-id.content.items`
- 数组索引：`node-id.content[0]`
- 全局数据：`$name`
- 严格比较：`left === right`、`left !== right`

节点 ID 允许字母、数字、下划线和连字符。语法无法识别时抛出明确错误；引用存在但值为空时返回 `null`。

## 生命周期与失败语义

1. 每轮请求创建独立 orchestrator 和活动图表。
2. 主 Agent 创建图，并可在执行前注册 resolver。
3. `executeDynamicGraph` 启动节点并持续调度动态新增节点。
4. 节点失败后，`onFailure` 分支仍可执行；没有恢复路径的下游标记为不可达。
5. resolver 失败保留源节点结果，同时记录 `ResolverFailed` 并进入图失败摘要。
6. 用户点击 Stop 时取消父运行、图、运行中子 Agent和待执行节点，只发出取消结果。
7. 主 Agent根据结构化图结果生成最终回复。

图创建、强制工具调用、执行或汇总任一步失败时，本轮返回错误。系统不退回旧 ReAct 直答路径。

## 安全约束

- `runCommand` 保留现有逐命令审批、工作区根目录限制和进程取消语义。
- `applyEdit` 保留编辑预览、文件统计和撤销能力。
- executor 全局串行，避免跨节点写冲突。
- 上游节点输出继续用有尺寸上限的不可信数据块注入。
- resolver 不执行模型提供的代码、正则或函数。
- 图级上限继续约束节点数、深度、并发和单节点超时。

## 测试与验收

### 核心测试

- Webview 不渲染模式按钮，提交消息不含 `mode`。
- 旧 checkpoint 带 `mode` 时仍可恢复，新 checkpoint 不再写入。
- 主 Agent 只有动态图控制工具，缺少创建或执行调用时运行失败。
- `createDynamicGraph` 完整解析所有节点字段和图级数据。
- `fanout`、`conditional`、`iterative` 各有一个真实 resolver 测试。
- 连字符节点引用和严格比较表达式通过。
- 只读节点并行，executor 串行。
- 命令拒绝、节点失败、resolver 失败和 Stop 取消均有可观察结果。
- executor 可通过 mock 工具完成一次读取、编辑和命令执行闭环。

### 整体验证

使用同一个 Extension Development Host 和 DeepSeek v4 Flash 提交复杂项目问题，验证：

1. UI 显示图创建、节点状态和图完成。
2. 实际工具历史包含 `createDynamicGraph` 和 `executeDynamicGraph`。
3. 至少两个只读节点并行执行，一个 reviewer 依赖其结果。
4. 最终回复引用真实源码证据。
5. 不创建第二个调试窗口，不修改用于 E2E 的项目文件。

最终运行：

```powershell
npm run compile
npm run typecheck
npm test
git diff --check
```

当前未接线的 `src/extension/agent/toolDispatcher.ts` 只做通过类型检查所需的最小修复，不注册到生产运行时。

## 预计修改范围

- `src/webview/App.tsx` 及对应 UI 测试
- `src/shared/messages.ts`
- `src/shared/chatTypes.ts`
- `src/extension.ts`
- `src/extension/agentRunner.ts`
- `src/extension/model/providerRegistry.ts`
- `src/extension/agent/dynamicWorkflowTools.ts`
- `src/extension/agent/workflow/types.ts`
- `src/extension/agent/workflow/roleRegistry.ts`
- `src/extension/agent/workflowOrchestrator.ts`
- `src/extension/agent/workflow/dataFlowManager.ts`
- 动态图、provider、会话恢复与 Webview 的相关测试
- `docs/development.md` 和动态图使用指南
