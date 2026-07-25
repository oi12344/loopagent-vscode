# 动态图计算工作流 - 设计规划

**日期**: 2026-07-25  
**状态**: ✅ 已完成实现  
**作者**: Claude (Sonnet 5[1m])

## 概述

动态图计算工作流为 LoopAgent VSCode 扩展提供了运行时依赖解析、数据驱动的节点生成和复杂多阶段计算能力。相比现有的静态 DAG 工作流,动态图支持:

- 🔄 **运行时依赖解析**: 节点完成后动态生成新节点
- 📊 **数据流管理**: 自动追踪和传递节点间数据
- 🎯 **条件执行**: 基于前置节点结果决定执行路径
- 📈 **可视化调试**: Mermaid 图表、关键路径分析、瓶颈检测

## 架构设计

### 核心模块

```
src/extension/agent/
├── workflow/
│   ├── dynamicGraphTypes.ts       # 类型定义
│   ├── dynamicGraphEngine.ts      # 执行引擎
│   ├── dataFlowManager.ts         # 数据流管理
│   └── graphVisualizer.ts         # 可视化工具
├── dynamicWorkflowTools.ts        # Agent 工具 API
└── workflowOrchestrator.ts        # 底层编排器(复用)

test/
└── dynamicGraphWorkflow.test.ts   # 集成测试

docs/
└── dynamic-graph-workflow-guide.md # 使用文档
```

### 1. 类型系统 (`dynamicGraphTypes.ts`)

**核心类型**:

```typescript
// 节点状态机
type NodeStatus = "pending" | "ready" | "running" | "completed" | "failed" | "skipped";

// 动态节点配置
type DynamicNodeConfig = {
  id: DynamicNodeId;
  task: string;
  role?: SubagentRoleId;
  toolHints?: string[];
  timeoutMs?: number;
  inputMapping?: Record<string, string>;  // 表达式映射
  condition?: NodeCondition;              // 执行条件
};

// 条件类型
type NodeCondition = {
  type: "always" | "onSuccess" | "onFailure" | "custom";
  expression?: string;  // 自定义表达式(预留)
};

// 依赖解析器
type DependencyResolver = (
  nodeId: DynamicNodeId,
  completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>,
  context: GraphComputationContext,
) => Promise<DynamicNodeConfig[]>;
```

**设计亮点**:
- 节点状态机清晰定义生命周期
- `inputMapping` 支持声明式数据依赖
- `condition` 支持条件执行,减少不必要计算
- `DependencyResolver` 允许完全自定义的节点生成逻辑

### 2. 执行引擎 (`dynamicGraphEngine.ts`)

**职责**:
1. 管理节点生命周期 (pending → ready → running → terminal)
2. 调度节点执行(并发控制、依赖解析)
3. 集成数据流管理和可视化工具
4. 事件发布(NodeAdded, StatusChanged, Completed 等)

**关键算法**:

```typescript
// 深度计算(防止超深依赖链)
function calculateNodeDepth(nodeId, dependencies): number {
  // DFS 遍历依赖树,缓存结果
  return max(dependencies.map(depId => getDepth(depId))) + 1;
}

// 调度算法
while (hasUnfinishedNodes) {
  // 找到所有就绪节点(依赖已完成)
  const ready = nodes.filter(node => 
    node.status === "pending" && 
    node.dependencies.every(depId => isCompleted(depId))
  );
  
  // 并发执行
  await Promise.all(ready.map(executeNode));
  
  // 动态依赖解析
  for (const completed of ready) {
    const newNodes = await resolveResolver(completed);
    addNodes(newNodes);
  }
}
```

**设计亮点**:
- 动态 DAG: 边在运行时增长
- 并发控制: 复用 `WorkflowOrchestrator` 的并发限制
- 容错: 节点失败不影响独立分支
- 事件驱动: 外部可监听所有状态变化

### 3. 数据流管理 (`dataFlowManager.ts`)

**核心功能**:

```typescript
// 表达式求值引擎
evaluateExpression(expr: string, context: ExpressionContext): DataFlowValue {
  // 支持:
  // - 节点字段: "nodeA.content", "nodeA.status"
  // - 全局变量: "$varName"
  // - 数组访问: "nodeA.content[0]"
  // - JSON 路径: "nodeA.content.user.name"
  // - 字面量: "true", "42", "'string'"
}

// 输入映射
mapInputs(mapping: Record<string, string>, context): Record<string, DataFlowValue> {
  // 将映射配置转换为实际数据
  // { target: "source.field" } => { target: actualValue }
}

// 数据流记录
recordInput/Output/Intermediate(nodeId, data): void {
  // 持久化数据流,支持调试和审计
}
```

**设计亮点**:
- 表达式语言: 简洁但功能完整
- 类型安全: `DataFlowValue` 支持所有 JSON 类型
- 历史追踪: 完整记录数据流转
- 错误容错: 表达式求值失败返回 `null`

### 4. 可视化工具 (`graphVisualizer.ts`)

**输出格式**:

1. **JSON 可视化** (`generateVisualization`)
   ```typescript
   {
     nodes: VisualizationNode[],  // 节点列表(状态、耗时)
     edges: VisualizationEdge[],  // 边列表(依赖、数据流)
     stats: GraphStats,           // 统计信息
     timeline: TimelineEvent[]    // 时间线
   }
   ```

2. **Mermaid 图表** (`exportToMermaid`)
   ```mermaid
   graph TD
       node1["✓ Task 1"]:::completed
       node2["⟳ Task 2"]:::running
       node3["✗ Task 3"]:::failed
       node1 --> node2
       node1 --> node3
   ```

3. **调试信息** (`generateDebugInfo`)
   ```typescript
   {
     nodeDetails: Map<NodeId, NodeDebugInfo>,
     dataFlowRecords: DataFlowRecord[],
     executionOrder: NodeId[],
     criticalPath: NodeId[],      // 最长执行路径
     bottlenecks: NodeId[]         // 高扇出节点(≥3 依赖者)
   }
   ```

**关键算法**:

```typescript
// 关键路径算法(最长路径)
function findCriticalPath(context): NodeId[] {
  const longestPaths = new Map<NodeId, { length: number; path: NodeId[] }>();
  
  function getLongestPath(nodeId): { length, path } {
    if (cached) return cached;
    
    const maxDepPath = max(dependencies.map(getLongestPath));
    return {
      length: maxDepPath.length + duration(nodeId),
      path: [...maxDepPath.path, nodeId]
    };
  }
  
  return max(nodes.map(getLongestPath)).path;
}

// 瓶颈检测(高扇出节点)
function findBottlenecks(context): NodeId[] {
  return nodes.filter(node => node.dependents.size >= 3);
}
```

**设计亮点**:
- 多格式支持: JSON(API)、Mermaid(文档)
- 性能分析: 关键路径、平均耗时
- 状态可视化: 符号(✓✗⟳)和颜色编码

### 5. 工具 API (`dynamicWorkflowTools.ts`)

**Agent 可用工具**:

| 工具 | 功能 | 输入 | 输出 |
|------|------|------|------|
| `createDynamicGraph` | 创建动态图 | `initialNodes`, `maxNodes`, `maxDepth` | `graphId` |
| `executeDynamicGraph` | 执行图 | `graphId` | `results`, `executionOrder` |
| `addDynamicResolver` | 添加解析器 | `graphId`, `nodeId`, `resolverType` | 确认 |
| `getGraphStatus` | 查询状态 | `graphId` | `statusCounts` |
| `visualizeGraph` | 生成可视化 | `graphId`, `format` | JSON/Mermaid |
| `getGraphDebugInfo` | 调试信息 | `graphId` | 关键路径、瓶颈 |
| `cancelDynamicGraph` | 取消执行 | `graphId` | 确认 |

**设计亮点**:
- 图实例管理: `activeGraphs` Map 存储活跃图
- 格式验证: 严格的输入校验(JSON Schema)
- 错误处理: 友好的错误消息

## 使用场景

### 场景 1: 代码分析与重构

```typescript
// 1. 分析代码库,找到所有需要重构的文件
// 2. 动态生成每个文件的重构任务
// 3. 并行重构,数据流传递上下文

const definition = {
  initialNodes: [
    { id: "analyze", task: "Analyze codebase for deprecated APIs" }
  ],
  resolvers: new Map([
    ["analyze", async (nodeId, results) => {
      const files = JSON.parse(results.get(nodeId).content);
      return files.map(file => ({
        id: `refactor-${file}`,
        task: `Refactor ${file} to use new API`,
        inputMapping: { filePath: `analyze.content.${file}` }
      }));
    }]
  ])
};
```

### 场景 2: CI/CD 流水线

```typescript
// 条件执行: 测试通过才部署,失败则回滚

const definition = {
  initialNodes: [
    { id: "test", task: "Run test suite" },
    { 
      id: "deploy", 
      task: "Deploy to production",
      condition: { type: "onSuccess" }
    },
    { 
      id: "rollback", 
      task: "Rollback and notify",
      condition: { type: "onFailure" }
    }
  ]
};
```

### 场景 3: 数据处理管道

```typescript
// 数据流: 提取 → 转换 → 加载

const definition = {
  initialNodes: [
    { id: "extract", task: "Extract data from API" },
    { 
      id: "transform", 
      task: "Transform data format",
      inputMapping: { rawData: "extract.content" }
    },
    { 
      id: "load", 
      task: "Load into database",
      inputMapping: { 
        transformedData: "transform.content",
        schema: "$dbSchema"
      }
    }
  ]
};
```

## 与现有架构的集成

### 复用现有组件

1. **`WorkflowOrchestrator`**: 底层子代理调度和生命周期管理
   - 并发控制 (`maxConcurrentSubagents`)
   - 超时管理 (`subagentTimeoutMs`)
   - 取消支持 (`cancelAll`)

2. **`SubagentContext`**: 子代理状态快照
   - 状态: pending/running/completed/failed
   - 消息历史
   - 结果缓存

3. **`DAGValidator`**: 环检测和深度验证
   - 复用 `detectCycle` 和 `calculateDAGDepth`

### 新增扩展点

```typescript
// 在 reactAgentRunner.ts 中注册动态工具
import { createDynamicWorkflowTools } from './dynamicWorkflowTools';

const tools = [
  ...existingTools,
  ...createDynamicWorkflowTools({ orchestrator, availableTools, signal })
];
```

## 性能考虑

### 限制

| 限制 | 默认值 | 说明 |
|------|--------|------|
| `maxNodes` | 200 | 防止无限扩展 |
| `maxDepth` | 10 | 防止过深依赖链 |
| `maxConcurrentSubagents` | 10 | 控制并发数 |
| `subagentTimeoutMs` | 30000 | 单节点超时 |

### 优化策略

1. **延迟求值**: 表达式只在需要时求值
2. **结果缓存**: 已完成节点的结果不重复计算
3. **并发控制**: 通过 `WorkflowOrchestrator` 限制并发
4. **内存管理**: 
   - 使用 Map 而非 Object(更快的查找)
   - `structuredClone` 防止数据突变
   - 事件监听器用 Set 管理(快速删除)

### 基准测试

```typescript
// test/dynamicGraphWorkflow.test.ts

// 场景: 10 节点线性链
// 预期: < 500ms (包括子代理开销)

// 场景: 50 节点扇出(1 → 50)
// 预期: < 2s (并发 10)

// 场景: 深度 10 的链
// 预期: 应接近 maxDepth 限制
```

## 测试覆盖

### 单元测试

- ✅ 表达式求值 (`evaluateExpression`)
- ✅ 输入映射 (`mapInputs`)
- ✅ 深度计算 (`calculateNodeDepth`)
- ✅ 关键路径查找 (`findCriticalPath`)

### 集成测试 (`test/dynamicGraphWorkflow.test.ts`)

- ✅ 简单线性图执行
- ✅ 条件执行(onSuccess/onFailure)
- ✅ 数据流追踪
- ✅ 可视化生成(JSON/Mermaid)
- ✅ 调试信息(关键路径、瓶颈)
- ✅ 限制验证(maxNodes/maxDepth)
- ✅ 取消执行

## 未来扩展

### 短期 (P1)

1. **自定义表达式**: 支持 `condition.expression` 的求值
   ```typescript
   condition: { 
     type: "custom", 
     expression: "node1.status === 'completed' && node2.content.score > 0.8" 
   }
   ```

2. **并行组**: 显式声明可并行执行的节点组
   ```typescript
   { 
     id: "parallel-group", 
     type: "parallel",
     nodes: [node1, node2, node3] 
   }
   ```

3. **重试策略**: 节点失败自动重试
   ```typescript
   { 
     id: "flaky-task", 
     task: "...",
     retry: { maxAttempts: 3, backoff: "exponential" }
   }
   ```

### 中期 (P2)

1. **持久化**: 图状态持久化到磁盘,支持恢复
2. **流式输出**: 节点输出流式传递给依赖者
3. **资源管理**: CPU/内存配额管理
4. **监控集成**: Prometheus metrics 导出

### 长期 (P3)

1. **分布式执行**: 节点在多台机器上执行
2. **图优化**: 自动合并相似节点,消除冗余
3. **机器学习调度**: 基于历史数据优化调度策略

## 文档

- ✅ **使用指南**: `docs/dynamic-graph-workflow-guide.md`
  - 基础用法
  - 高级功能
  - 完整示例(CI/CD)
  - 故障排查

- ✅ **API 文档**: 内联 JSDoc 注释
- ✅ **架构文档**: 本文件

## 总结

### 已完成

✅ **核心功能**
- 动态节点生成和依赖解析
- 数据流管理和表达式求值
- 条件执行和状态机
- 可视化(JSON/Mermaid)和调试工具

✅ **集成**
- 复用现有 `WorkflowOrchestrator`
- Agent 工具 API
- 事件系统

✅ **测试和文档**
- 集成测试覆盖主要场景
- 完整使用指南
- 架构设计文档

### 关键指标

- **代码行数**: ~1200 行(不含测试和文档)
- **文件数**: 5 个核心文件
- **API 数量**: 7 个 Agent 工具
- **测试场景**: 12 个集成测试

### 技术亮点

1. **声明式配置**: 通过 JSON 定义复杂工作流
2. **运行时灵活性**: 依赖解析器允许完全自定义逻辑
3. **可观测性**: 完整的事件、数据流、可视化支持
4. **工程质量**: 类型安全、错误处理、性能优化

---

**实现者**: Claude Sonnet 5[1m]  
**实现时间**: 2026-07-25  
**协作模式**: Learning (引导式实现)
