# 合并动态图控制工具计划

## 目标

把主 Agent 的 7 个图控制工具合并为 1 个 `runDynamicGraph`，消除 `createDynamicGraph` → `executeDynamicGraph` 之间那次无决策价值的模型往返。

典型单节点请求的强模型往返从 5 次降到 4 次；`graphId` 不再对外暴露，图的生命周期收敛到单次 `invoke()` 调用内。

## 背景

现状 `createDynamicGraph` 返回 `graphId`，模型唯一能做的就是原样传回给 `executeDynamicGraph`。这次往返纯属浪费。

顺带修掉一个隐患：两个工具都声明 `isConcurrencySafe: () => true`，若模型把它们放进同一轮，`createToolRequestBatches` 会并发执行，而 execute 依赖 create 返回的 ID，只能靠猜（`graph-1` 恰好可猜中）。

## 非目标

- 不改 `DynamicGraphEngine`、`WorkflowOrchestrator`、角色权限或调度语义
- 不接入 `toolDispatcher.ts`
- 不动方案 B（单节点结果直通）和方案 C（图控制器换小模型）
- 不改已归档的 dated 设计/计划文档（历史记录）

## 工具契约

### 输入

```typescript
type RunDynamicGraphInput = {
  initialNodes: DynamicNodeConfig[];        // 必填，schema 不变
  resolvers?: Array<{                       // 原 addDynamicResolver 折叠为入参
    nodeId: string;                         // 必须是 initialNodes 中的 id
    resolverType: "fanout" | "conditional" | "iterative";
    resolverConfig: object;                 // 各类型配置不变
  }>;
  initialGlobalData?: Record<string, DataFlowValue>;
  maxNodes?: number;
  maxDepth?: number;
  include?: Array<"visualization" | "debug" | "mermaid">;   // 按需带回观测数据
};
```

### 输出

```typescript
{
  nodes: Array<{ id, role, dependsOn }>;    // 保留：E2E oracle 依赖此字段校验图结构
  totalNodes: number;                        // 原 getGraphStatus
  statusCounts: Record<string, number>;      // 原 getGraphStatus
  completedNodes: string[];
  results: Record<string, SubagentResult>;
  executionOrder: string[];
  resolverFailures: Array<{ nodeId, error }>;
  visualization?: GraphVisualization;        // 仅当 include 含 "visualization"
  debugInfo?: GraphDebugInfo;                // 仅当 include 含 "debug"
  mermaid?: string;                          // 仅当 include 含 "mermaid"
}
```

`include` 未指定时三个可选字段全部缺席，不占 token。这保留了 design.md 要求的"可视化可从生产工具调用到达"。

### 并发声明

`isConcurrencySafe` 改为 `() => false`（或省略该字段，`isConcurrencySafe()` 对缺失字段返回 `false`）。合并后这个工具会跑完整张图，含 executor 的写操作；两次并发调用会绕过 orchestrator 的 executor 串行闸门。

## 实现步骤

### 1. `src/extension/agent/dynamicWorkflowTools.ts`

- `createDynamicWorkflowTools()` 返回单元素数组，只含 `runDynamicGraph`
- 删除模块级 `activeGraphs` Map 和 `nextGraphId`；图对象在 `invoke()` 内构造，作用域即调用周期
- `invoke()` 顺序：解析入参 → `validateInitialGraph()` → 建空 resolvers Map → `createDynamicGraphEngine()` → 组装 `ActiveGraph` → 逐个校验并注册 resolver（`nodeId` 必须 ∈ initialNodeIds）→ 订阅 `ResolverFailed` → `engine.execute()` → 组装结果 → `finally` 取消订阅
- 新增 `RESOLVER_SCHEMA` 常量，复用现有 `resolverConfig` 属性定义
- 所有 parse/require 辅助函数、`createConfiguredResolver` 及三个 resolver 工厂保持不变
- resolvers Map 与 engine 的循环依赖照旧解法：先建空 Map 传给 engine，engine 创建后再往 Map 里填（`resolveDependencies` 是执行时才 `definition.resolvers?.get(nodeId)`）

### 2. `src/extension/model/providerRegistry.ts`

- `requiredToolNames: ["runDynamicGraph"]`
- `DYNAMIC_GRAPH_SYSTEM_PROMPT` 改写两条：
  - 建图+执行合并为一次调用
  - `addDynamicResolver` 改为 `resolvers` 入参

### 3. 测试

| 文件 | 改动 |
|---|---|
| `test/dynamicWorkflowTools.test.ts` | 重写 `createGraph`/`invoke` 辅助；4 个用例改为单次调用；删除 stale-graphId 断言；新增 `include` 开/关两种断言 |
| `test/providerRegistryCodeContext.test.ts` | 工具名数组 2 处、required-tools 报错文案 1 处、mock provider 回合序列 3 处（2 轮塌缩为 1 轮） |
| `examples/test/dynamicGraphToolExecution.test.ts` | 重写为单工具调用；删除依赖已释放图的 `toThrow` 断言 |
| `test/codeExplorationE2e.test.ts` | `completeProcess` 字符串、期望 `toolCalls` 数组 |
| `scripts/codeExplorationE2e.js` | `REQUIRED_STATES`、`toolCalls` filter |
| `scripts/run-code-exploration-e2e.mjs` | `call.name === "createDynamicGraph"` → `"runDynamicGraph"` |

`examples/` 下另外 4 份纯 console 演示脚本按用户决定不改（不进 typecheck 也不进 vitest）。

### 4. 文档

- `docs/superpowers/guides/dynamic-graph-runtime.md` — 工具清单、create/execute 相关段落
- `docs/development.md:115` — E2E 判定提到的工具名

### 5. 待人工决策点

实现到结果组装时插入一个 `TODO(human)`：全部节点失败时（`completedNodes` 为空）工具该返回什么。当前 `execute()` 正常 resolve，工具会返回"成功"结果，`requiredToolNames` 因此被满足，模型可能在零证据下给出最终回答。这个语义需要定。

## 验收

```powershell
npm run compile
npm run typecheck
npm test
git diff --check
```

真实 DeepSeek E2E（`npm run test:e2e:code-exploration`）需要复用唯一 Extension Development Host，本次不自动执行。
