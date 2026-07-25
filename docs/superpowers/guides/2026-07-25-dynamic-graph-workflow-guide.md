# 动态图计算工作流使用指南

## 概述

动态图计算工作流是 LoopAgent 的高级功能,支持运行时依赖解析、数据驱动的节点生成和复杂的多阶段计算流程。

## 核心概念

### 1. 动态节点 (Dynamic Node)
- **节点状态**: pending → ready → running → completed/failed/skipped
- **输入映射**: 从前置节点提取数据作为输入
- **条件执行**: 基于前置节点结果决定是否执行

### 2. 依赖解析器 (Dependency Resolver)
- 在节点完成后动态生成新节点
- 支持扇出 (fanout)、条件分支 (conditional)、迭代 (iterative) 模式

### 3. 数据流管理 (Data Flow)
- 自动记录节点间的数据传递
- 支持表达式求值 (如 `node1.content`, `$globalVar`)
- 提供完整的数据流历史追踪

## 基础用法

### 示例 1: 简单线性流程

```typescript
import { createDynamicGraphEngine } from './workflow/dynamicGraphEngine';
import { createWorkflowOrchestrator } from './workflowOrchestrator';

const orchestrator = createWorkflowOrchestrator({
  createRunner: myRunnerFactory,
});

const definition = {
  initialNodes: [
    { 
      id: "read", 
      task: "Read configuration file" 
    },
    { 
      id: "validate", 
      task: "Validate configuration",
      inputMapping: { 
        config: "read.content" 
      }
    },
    { 
      id: "deploy", 
      task: "Deploy with validated config",
      inputMapping: { 
        validatedConfig: "validate.content" 
      }
    }
  ]
};

const engine = createDynamicGraphEngine({
  definition,
  orchestrator,
  availableTools: myTools,
});

const results = await engine.execute();
```

### 示例 2: 条件执行

```typescript
const definition = {
  initialNodes: [
    { 
      id: "test", 
      task: "Run tests" 
    },
    { 
      id: "deploy", 
      task: "Deploy to production",
      condition: { type: "onSuccess" },  // 仅在测试成功时执行
      inputMapping: { 
        testResults: "test.content" 
      }
    },
    { 
      id: "rollback", 
      task: "Rollback changes",
      condition: { type: "onFailure" },  // 仅在测试失败时执行
    }
  ]
};
```

### 示例 3: 数据流表达式

支持的表达式类型:

```typescript
const mapping = {
  // 节点字段引用
  content: "sourceNode.content",
  status: "sourceNode.status",
  error: "sourceNode.error",
  
  // 全局变量
  config: "$globalConfig",
  
  // 数组访问
  firstItem: "listNode.content[0]",
  
  // JSON 路径
  nestedValue: "dataNode.content.user.name",
  
  // 字面量
  flag: "true",
  count: "42",
  message: "'hello world'",
};
```

## 高级功能

### 1. 动态依赖解析

```typescript
const definition = {
  initialNodes: [
    { id: "analyze", task: "Analyze codebase" }
  ],
  resolvers: new Map([
    ["analyze", async (nodeId, completedNodes, context) => {
      // 根据分析结果动态生成处理节点
      const analysisResult = completedNodes.get(nodeId);
      const files = JSON.parse(analysisResult.content);
      
      return files.map((file, index) => ({
        id: `process-${index}`,
        task: `Process file: ${file}`,
        inputMapping: {
          filePath: `analyze.content.files[${index}]`
        }
      }));
    }]
  ])
};
```

### 2. 可视化和调试

```typescript
// 生成 JSON 可视化
const visualizer = engine.getVisualizer();
const viz = visualizer.generateVisualization();

console.log(`总节点数: ${viz.stats.totalNodes}`);
console.log(`已完成: ${viz.stats.completedNodes}`);
console.log(`失败: ${viz.stats.failedNodes}`);
console.log(`平均执行时间: ${viz.stats.avgDuration}ms`);

// 导出 Mermaid 图表
const mermaid = visualizer.exportToMermaid();
// graph TD
//     node1["✓ Read configuration..."]:::completed
//     node2["✓ Validate configuration..."]:::completed
//     node1 --> node2

// 获取调试信息
const debugInfo = visualizer.generateDebugInfo();
console.log("关键路径:", debugInfo.criticalPath);
console.log("瓶颈节点:", debugInfo.bottlenecks);
console.log("执行顺序:", debugInfo.executionOrder);
```

### 3. 数据流追踪

```typescript
const dataFlowManager = engine.getDataFlowManager();

// 获取特定节点的数据流
const nodeData = dataFlowManager.getNodeData("processNode");
nodeData.forEach(record => {
  console.log(`${record.source}: ${JSON.stringify(record.data)}`);
});

// 获取完整数据流历史
const history = dataFlowManager.getFlowHistory();
console.log(`总共 ${history.length} 条数据流记录`);
```

## 工具 API

### createDynamicGraph

创建动态计算图:

```json
{
  "initialNodes": [
    {
      "id": "node1",
      "task": "Task description",
      "role": "explorer",
      "toolHints": ["readFile", "writeFile"],
      "timeoutMs": 30000,
      "inputMapping": {
        "key": "sourceNode.content"
      },
      "condition": {
        "type": "onSuccess"
      }
    }
  ],
  "maxNodes": 100,
  "maxDepth": 5
}
```

### executeDynamicGraph

执行图并返回结果:

```json
{
  "graphId": "graph-1"
}
```

返回:
```json
{
  "graphId": "graph-1",
  "completedNodes": ["node1", "node2", "node3"],
  "results": {
    "node1": { "status": "completed", "content": "..." },
    "node2": { "status": "completed", "content": "..." }
  },
  "executionOrder": ["node1", "node2", "node3"]
}
```

### visualizeGraph

生成可视化:

```json
{
  "graphId": "graph-1",
  "format": "mermaid"
}
```

### getGraphDebugInfo

获取调试信息:

```json
{
  "graphId": "graph-1"
}
```

返回:
```json
{
  "nodeDetails": { ... },
  "dataFlowRecords": [ ... ],
  "executionOrder": [ ... ],
  "criticalPath": ["node1", "node3", "node5"],
  "bottlenecks": ["node3"]
}
```

## 性能考虑

### 限制配置

```typescript
const definition = {
  initialNodes: [...],
  maxNodes: 200,      // 最大节点数
  maxDepth: 10,       // 最大依赖深度
};

const orchestrator = createWorkflowOrchestrator({
  createRunner: myRunnerFactory,
  limits: {
    maxSubagentsPerRun: 50,
    maxNestingDepth: 3,
    maxConcurrentSubagents: 10,  // 并发限制
    subagentTimeoutMs: 30000,
  }
});
```

### 最佳实践

1. **合理设置并发数**: 根据系统资源调整 `maxConcurrentSubagents`
2. **避免过深的依赖链**: 深度超过 10 层时考虑重构
3. **使用条件执行**: 减少不必要的节点执行
4. **监控关键路径**: 优化关键路径上的节点性能
5. **设置合理超时**: 防止单个节点阻塞整个流程

## 完整示例: CI/CD 流程

```typescript
const cicdDefinition = {
  initialNodes: [
    { 
      id: "checkout", 
      task: "Checkout code from repository" 
    },
    { 
      id: "install", 
      task: "Install dependencies",
      inputMapping: { repo: "checkout.content" }
    },
    { 
      id: "lint", 
      task: "Run linter",
      condition: { type: "onSuccess" }
    },
    { 
      id: "test", 
      task: "Run test suite",
      condition: { type: "onSuccess" }
    },
    { 
      id: "build", 
      task: "Build production bundle",
      condition: { type: "onSuccess" },
      inputMapping: { 
        testResults: "test.content" 
      }
    },
    { 
      id: "deploy-staging", 
      task: "Deploy to staging",
      condition: { type: "onSuccess" },
      inputMapping: { 
        artifact: "build.content" 
      }
    },
    { 
      id: "smoke-test", 
      task: "Run smoke tests on staging",
      condition: { type: "onSuccess" }
    },
    { 
      id: "deploy-prod", 
      task: "Deploy to production",
      condition: { type: "onSuccess" },
      inputMapping: { 
        artifact: "build.content",
        stagingResults: "smoke-test.content"
      }
    },
    { 
      id: "notify-success", 
      task: "Send success notification",
      condition: { type: "onSuccess" }
    },
    { 
      id: "notify-failure", 
      task: "Send failure notification and create incident",
      condition: { type: "onFailure" }
    }
  ],
  maxNodes: 50,
  maxDepth: 8
};

const engine = createDynamicGraphEngine({
  definition: cicdDefinition,
  orchestrator,
  availableTools: cicdTools,
});

// 监听事件
engine.onEvent((event) => {
  if (event.type === "NodeCompleted") {
    console.log(`✓ ${event.nodeId} completed`);
  } else if (event.type === "GraphCompleted") {
    console.log("CI/CD pipeline finished!");
  }
});

const results = await engine.execute();

// 生成报告
const visualizer = engine.getVisualizer();
const report = visualizer.generateVisualization();
console.log(`Pipeline stats:
  Total steps: ${report.stats.totalNodes}
  Completed: ${report.stats.completedNodes}
  Failed: ${report.stats.failedNodes}
  Duration: ${report.stats.avgDuration}ms average per step
`);
```

## 故障排查

### 常见问题

1. **循环依赖**: 检查节点依赖关系,确保没有环
2. **超时**: 增加 `timeoutMs` 或优化任务执行时间
3. **内存溢出**: 减少 `maxNodes` 或 `maxConcurrentSubagents`
4. **数据传递失败**: 检查 `inputMapping` 表达式是否正确

### 调试技巧

```typescript
// 1. 启用详细日志
engine.onEvent((event) => {
  console.log(JSON.stringify(event, null, 2));
});

// 2. 检查数据流
const dataFlow = engine.getDataFlowManager();
console.log("Data flow history:", dataFlow.getFlowHistory());

// 3. 导出 Mermaid 图表分析依赖关系
const mermaid = engine.getVisualizer().exportToMermaid();
console.log(mermaid);

// 4. 查看关键路径
const debugInfo = engine.getVisualizer().generateDebugInfo();
console.log("Critical path:", debugInfo.criticalPath);
console.log("Bottlenecks:", debugInfo.bottlenecks);
```

## 扩展阅读

- [工作流编排器设计](../docs/superpowers/specs/2026-07-24-subagent-workflow-execution-plan.md)
- [子代理上下文管理](../src/extension/agent/subagentContext.ts)
- [DAG 验证器](../src/extension/agent/workflow/dagValidator.ts)
