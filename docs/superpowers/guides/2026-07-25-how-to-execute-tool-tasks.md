# 如何执行动态图工具任务

## 概述

动态图计算工作流通过 7 个工具 API 提供给 Agent 使用。Agent 可以像调用其他工具一样调用这些工具来完成复杂的动态计算任务。

## 工具 API 列表

| 工具名称 | 功能 | 输入 | 输出 |
|---------|------|------|------|
| `createDynamicGraph` | 创建动态图 | 初始节点配置 | 图 ID |
| `executeDynamicGraph` | 执行图 | 图 ID | 执行结果 |
| `addDynamicResolver` | 添加解析器 | 图 ID, 节点 ID, 解析器类型 | 确认 |
| `getGraphStatus` | 查询状态 | 图 ID | 状态统计 |
| `visualizeGraph` | 生成可视化 | 图 ID, 格式 | JSON/Mermaid |
| `getGraphDebugInfo` | 调试信息 | 图 ID | 性能分析 |
| `cancelDynamicGraph` | 取消执行 | 图 ID | 确认 |

## 完整执行流程

### 步骤 1: 创建动态图

**工具**: `createDynamicGraph`

```json
{
  "tool": "createDynamicGraph",
  "input": {
    "initialNodes": [
      {
        "id": "analyze",
        "task": "分析代码库",
        "role": "explorer",
        "toolHints": ["readFile", "listFiles"]
      }
    ],
    "maxNodes": 100,
    "maxDepth": 5
  }
}
```

**返回**:
```json
{
  "graphId": "graph-1",
  "nodeCount": 1
}
```

### 步骤 2: 执行动态图

**工具**: `executeDynamicGraph`

```json
{
  "tool": "executeDynamicGraph",
  "input": {
    "graphId": "graph-1"
  }
}
```

**执行过程**:
1. 执行 "analyze" 节点
2. 节点完成后触发依赖解析器
3. 根据结果动态生成新节点
4. 并发执行所有新节点
5. 返回所有结果

**返回**:
```json
{
  "graphId": "graph-1",
  "completedNodes": ["analyze", "process-1", "process-2", "process-3"],
  "results": {
    "analyze": {
      "status": "completed",
      "content": "{\"files\": [\"a.ts\", \"b.ts\", \"c.ts\"]}"
    },
    "process-1": {
      "status": "completed",
      "content": "{\"result\": \"success\"}"
    }
  },
  "executionOrder": ["analyze", "process-1", "process-2", "process-3"]
}
```

### 步骤 3: 生成可视化

**工具**: `visualizeGraph`

```json
{
  "tool": "visualizeGraph",
  "input": {
    "graphId": "graph-1",
    "format": "mermaid"
  }
}
```

**返回**:
```json
{
  "graphId": "graph-1",
  "format": "mermaid",
  "diagram": "graph TD\n    analyze[\"✓ 分析代码库\"]:::completed\n    ..."
}
```

### 步骤 4: 获取调试信息

**工具**: `getGraphDebugInfo`

```json
{
  "tool": "getGraphDebugInfo",
  "input": {
    "graphId": "graph-1"
  }
}
```

**返回**:
```json
{
  "graphId": "graph-1",
  "criticalPath": ["analyze", "process-3"],
  "bottlenecks": ["analyze"],
  "dataFlowRecords": 8,
  "executionOrder": ["analyze", "process-1", "process-2", "process-3"]
}
```

## 实际示例: 代码审查工作流

### Agent 思考过程

```
用户请求: "审查最近的代码变更"

Agent 分析:
1. 需要先获取变更的文件列表 (未知数量)
2. 为每个文件创建审查任务
3. 汇总结果

决策: 使用动态图工作流
```

### 执行步骤

#### 1. 创建图
```json
{
  "tool": "createDynamicGraph",
  "input": {
    "initialNodes": [
      {
        "id": "get-changes",
        "task": "获取 Git 变更文件",
        "role": "explorer"
      }
    ]
  }
}
```
返回: `{ "graphId": "graph-abc" }`

#### 2. 执行图
```json
{
  "tool": "executeDynamicGraph",
  "input": {
    "graphId": "graph-abc"
  }
}
```

**内部执行流程**:
```
T+0ms:   执行 get-changes
T+100ms: get-changes 完成
         结果: { files: ["auth.ts", "api.ts", "test.ts"] }

T+110ms: 🔥 触发解析器
         动态生成 3 个新节点:
         - review-auth-ts
         - review-api-ts  
         - review-test-ts

T+120ms: 并发执行 3 个审查任务

T+250ms: 所有任务完成
```

返回:
```json
{
  "graphId": "graph-abc",
  "completedNodes": [
    "get-changes",
    "review-auth-ts",
    "review-api-ts",
    "review-test-ts"
  ],
  "results": {
    "get-changes": {
      "status": "completed",
      "content": "{\"files\":[\"auth.ts\",\"api.ts\",\"test.ts\"]}"
    },
    "review-auth-ts": {
      "status": "completed",
      "content": "{\"issues\":2,\"severity\":\"warning\"}"
    },
    "review-api-ts": {
      "status": "completed",
      "content": "{\"issues\":1,\"severity\":\"info\"}"
    },
    "review-test-ts": {
      "status": "completed",
      "content": "{\"issues\":0}"
    }
  }
}
```

#### 3. 生成报告
Agent 解析结果并生成用户友好的报告:

```
代码审查报告
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

审查文件: 3 个
发现问题: 3 个

详细:
  [auth.ts] ⚠️  2 个警告
  [api.ts]  ℹ️  1 个信息
  [test.ts] ✅ 无问题

性能:
  总耗时: 250ms
  并发: 3 个任务同时执行
```

## 关键特性

### 1. 运行时动态生成
- 启动时: 1 个节点
- 运行时: 根据数据生成 N 个节点
- 完成时: 1+N 个节点

### 2. 数据驱动
```javascript
// 解析器函数伪代码
resolver: async (nodeId, results) => {
  const data = results.get(nodeId);
  const files = JSON.parse(data.content).files;
  
  // 根据实际文件数量生成任务
  return files.map(file => ({
    id: `review-${file}`,
    task: `审查 ${file}`
  }));
}
```

### 3. 并发执行
- 自动识别可并行节点
- 根据 `maxConcurrentSubagents` 限制并发
- 提升执行效率

### 4. 完整可观测性
- 事件流: 每个节点的状态变化
- 数据流: 节点间的数据传递
- 可视化: Mermaid 图表
- 性能: 关键路径、瓶颈分析

## 工具集成示例

### 在 ReactAgent 中使用

```typescript
// src/extension/agent/reactAgentRunner.ts

import { createDynamicWorkflowTools } from './dynamicWorkflowTools';

// 注册工具
const tools = [
  ...existingTools,
  ...createDynamicWorkflowTools({
    orchestrator,
    availableTools,
    signal
  })
];

// Agent 现在可以调用动态图工具
```

### Agent 调用示例

```typescript
// Agent 思考: 用户要我审查代码,我需要动态工作流

// 调用工具 1: 创建图
const createResult = await callTool({
  name: "createDynamicGraph",
  input: {
    initialNodes: [{
      id: "analyze",
      task: "分析代码"
    }]
  }
});

const graphId = JSON.parse(createResult).graphId;

// 调用工具 2: 执行图
const executeResult = await callTool({
  name: "executeDynamicGraph",
  input: { graphId }
});

// 调用工具 3: 可视化
const vizResult = await callTool({
  name: "visualizeGraph",
  input: { graphId, format: "mermaid" }
});

// 生成报告给用户
return generateReport(executeResult, vizResult);
```

## 适用场景

### 1. 批量操作
- 文件数量未知
- 需要并发处理
- 例: 重构多个文件

### 2. 多阶段流程
- 前一步结果决定后续步骤
- 例: CI/CD 流水线

### 3. 数据驱动任务
- 任务列表来自外部数据
- 例: 多仓库批量更新

### 4. 条件分支
- 根据结果选择不同路径
- 例: 测试失败 → 回滚,成功 → 部署

## 性能考虑

### 限制配置
```json
{
  "maxNodes": 100,              // 最大节点数
  "maxDepth": 5,                // 最大依赖深度
  "maxConcurrentSubagents": 10  // 最大并发数
}
```

### 优化建议
1. 合理设置并发数
2. 避免过深的依赖链
3. 使用条件执行减少不必要节点
4. 监控关键路径优化性能

## 总结

动态图工具任务执行流程:

```
Agent 接收任务
    ↓
分析任务特征 (动态、批量、多阶段)
    ↓
决策使用动态图工作流
    ↓
调用 createDynamicGraph 创建图
    ↓
调用 executeDynamicGraph 执行图
    ├→ 初始节点执行
    ├→ 触发解析器
    ├→ 动态生成新节点
    ├→ 并发执行所有节点
    └→ 返回结果
    ↓
调用 visualizeGraph 生成可视化
    ↓
调用 getGraphDebugInfo 获取性能数据
    ↓
整合结果生成用户报告
```

**核心价值**: 
- ✅ 运行时构建配置
- ✅ 数据驱动扩展
- ✅ 自动并发优化
- ✅ 完整可观测性

**实现文件**: 
- [dynamicWorkflowTools.ts](../src/extension/agent/dynamicWorkflowTools.ts) - 工具定义
- [dynamicGraphEngine.ts](../src/extension/agent/workflow/dynamicGraphEngine.ts) - 执行引擎

**文档**: 
- [使用指南](dynamic-graph-workflow-guide.md)
- [设计规划](superpowers/plans/2026-07-25-dynamic-graph-workflow-plan.md)
