# 双向图（有环图）支持 - 设计方案

**日期**: 2026-07-30  
**状态**: 设计阶段  
**作者**: Claude Opus 5

> 本文的 `cycles + resetNodeForCycle` 方案已由 [状态驱动动态工作流架构规格](../specs/2026-07-31-state-driven-dynamic-workflow-design.md) 替代。后续实现以语义计划、状态通道和 superstep 为准。

---

## 🎯 目标

为动态工作流系统添加真正的循环依赖支持，使得节点可以形成回路，实现更自然的迭代逻辑。

---

## 📊 当前状态分析

### 现有架构：严格 DAG

**核心约束**：
- ✅ 必须无环（`dagValidator.ts:detectCycle()`）
- ✅ 有最大深度限制（`maxDepth`）
- ✅ 节点状态单向流转：`pending → ready → running → completed`

**当前的"虚拟循环"方案**：

```typescript
// Reflection Resolver 的实现
review-1 → revise-2 → review-2 → revise-3 → review-3
    ↓          ↓          ↓          ↓          ↓
 (判断)    (自动创建)  (判断)    (自动创建)  (判断)
```

**优点**：
- ✅ 在 DAG 框架下工作
- ✅ 无需修改核心调度器
- ✅ 可视化为线性链

**缺点**：
- ❌ 配置复杂（需要 Resolver 回调）
- ❌ 每轮创建新节点（节点数膨胀）
- ❌ 不直观（看起来是链式而非循环）

---

## 🎨 双向图设计方案

### 方案 A：显式循环边（推荐）⭐

#### **核心概念**

在 DAG 基础上增加**循环边（Cycle Edges）**，作为特殊的元数据。

```typescript
// 新增类型定义
export type CycleEdge = {
  id: string;                    // 循环边唯一标识
  from: DynamicNodeId;           // 起点节点
  to: DynamicNodeId;             // 终点节点
  maxIterations: number;         // 最大迭代次数
  breakCondition?: string;       // 退出条件表达式
  currentIteration?: number;     // 当前轮数（运行时状态）
};

export type DynamicGraphDefinition = {
  initialNodes: DynamicNodeConfig[];
  resolvers?: Map<DynamicNodeId, DependencyResolver>;
  cycles?: CycleEdge[];          // 👈 新增：循环边定义
  maxNodes?: number;
  maxDepth?: number;
  initialGlobalData?: Record<string, DataFlowValue>;
};
```

#### **用户配置示例**

```typescript
runDynamicGraph({
  initialNodes: [
    {
      id: "implement",
      task: "实现用户认证功能",
      role: "executor"
    },
    {
      id: "review",
      task: "审查代码安全性。如果通过，回复「APPROVED」",
      role: "reviewer",
      dependsOn: ["implement"]
    },
    {
      id: "fix",
      task: "根据审查意见修复代码",
      role: "executor",
      dependsOn: ["review"],
      condition: {
        type: "custom",
        expression: "!nodes['review'].content.includes('APPROVED')"
      }
    }
  ],
  
  // 👇 新增：显式声明循环
  cycles: [
    {
      id: "review-fix-loop",
      from: "fix",              // fix 完成后
      to: "review",             // 重新执行 review
      maxIterations: 3,         // 最多 3 轮
      breakCondition: "nodes['review'].content.includes('APPROVED')"
    }
  ]
});
```

#### **执行流程**

```
初始状态：
  implement (pending)
  review (pending)
  fix (pending)

第 1 轮：
  implement → completed
  review (依赖满足) → running → completed (发现问题)
  fix (条件满足) → running → completed
  
  👉 触发循环边: fix → review
  
  review 状态重置: completed → pending-retry (新状态)
  review (依赖满足: fix completed) → running → completed (还有问题)
  
第 2 轮：
  fix 状态重置: completed → pending-retry
  fix → running → completed
  
  👉 触发循环边 (iteration=2)
  
  review 重置 → running → completed (APPROVED!)
  
  👉 breakCondition 满足，循环终止
  
最终状态：
  implement: completed (1次)
  review: completed (3次执行)
  fix: completed (2次执行)
```

---

### 实现细节

#### **1. 新增节点状态**

```typescript
// dynamicGraphTypes.ts
export type NodeStatus = 
  | "pending"          // 初始状态，等待依赖
  | "ready"            // 依赖满足，等待调度
  | "running"          // 执行中
  | "completed"        // 已完成
  | "failed"           // 失败
  | "skipped"          // 跳过
  | "cancelled"        // 取消
  | "pending-retry";   // 👈 新增：等待循环重试
```

#### **2. 循环管理器**

```typescript
// 新文件: src/extension/agent/workflow/cycleManager.ts

export type CycleState = {
  edge: CycleEdge;
  currentIteration: number;
  history: Array<{
    iteration: number;
    fromNodeResult: SubagentResult;
    toNodeResult?: SubagentResult;
    timestamp: Date;
  }>;
};

export class CycleManager {
  private cycles = new Map<string, CycleState>();
  
  constructor(private definition: CycleEdge[]) {
    for (const edge of definition) {
      this.cycles.set(edge.id, {
        edge,
        currentIteration: 0,
        history: []
      });
    }
  }
  
  // 检查节点完成时是否触发循环边
  checkTrigger(
    nodeId: DynamicNodeId,
    result: SubagentResult,
    context: GraphComputationContext
  ): CycleEdge | null {
    for (const [cycleId, state] of this.cycles) {
      const edge = state.edge;
      
      // 检查是否是循环起点
      if (edge.from !== nodeId) continue;
      
      // 检查是否达到最大轮数
      if (state.currentIteration >= edge.maxIterations) {
        console.log(`[CycleManager] ${cycleId} reached max iterations`);
        return null;
      }
      
      // 检查退出条件
      if (edge.breakCondition) {
        const shouldBreak = this.evaluateBreakCondition(
          edge.breakCondition,
          context
        );
        if (shouldBreak) {
          console.log(`[CycleManager] ${cycleId} break condition met`);
          return null;
        }
      }
      
      // 触发循环
      state.currentIteration++;
      state.history.push({
        iteration: state.currentIteration,
        fromNodeResult: result,
        timestamp: new Date()
      });
      
      return edge;
    }
    
    return null;
  }
  
  private evaluateBreakCondition(
    expression: string,
    context: GraphComputationContext
  ): boolean {
    // 使用 dataFlowManager 评估表达式
    // 实现略
    return false;
  }
  
  // 重置节点状态以便重新执行
  resetNode(nodeId: DynamicNodeId, node: DynamicNode): void {
    node.status = "pending-retry";
    node.result = undefined;
    node.subagentId = undefined;
    node.startedAt = undefined;
    node.finishedAt = undefined;
    // 保留 attempts（累计重试次数）
  }
}
```

#### **3. 修改调度器**

```typescript
// dynamicGraphEngine.ts - 修改 executeNode 后的处理

async function executeNode(node: DynamicNode, completedNodes) {
  // ... 现有执行逻辑
  
  if (result) {
    node.result = result;
    node.finishedAt = new Date();
    updateNodeStatus(node.config.id, terminalStatus);
    
    // 👇 新增：检查循环边触发
    const triggeredCycle = cycleManager.checkTrigger(
      node.config.id,
      result,
      context
    );
    
    if (triggeredCycle) {
      const targetNode = context.nodes.get(triggeredCycle.to);
      if (targetNode) {
        cycleManager.resetNode(triggeredCycle.to, targetNode);
        emit({
          type: "CycleTriggered",
          cycleId: triggeredCycle.id,
          fromNode: triggeredCycle.from,
          toNode: triggeredCycle.to,
          iteration: cycleManager.getCurrentIteration(triggeredCycle.id)
        });
        
        // 立即尝试调度目标节点
        launchReadyNodes();
      }
    }
    
    // ... 现有的 resolver 处理
  }
}
```

#### **4. 修改就绪检查**

```typescript
// dynamicGraphEngine.ts - 修改 isNodeReady

function isNodeReady(node: DynamicNode): boolean {
  // 支持 pending-retry 状态
  if (node.status !== "pending" && node.status !== "pending-retry") {
    return false;
  }
  
  return Array.from(node.dependencies).every((depId) => {
    const depNode = context.nodes.get(depId);
    return depNode?.status === "completed" || 
           depNode?.status === "failed" || 
           depNode?.status === "skipped";
  });
}
```

#### **5. 可视化增强**

```typescript
// graphVisualizer.ts - 新增循环边可视化

export type VisualizationEdge = {
  from: DynamicNodeId;
  to: DynamicNodeId;
  type: "dependency" | "dataflow" | "cycle";  // 👈 新增 cycle 类型
  label?: string;
  iteration?: number;  // 循环轮数
  style?: "dashed" | "solid";
};

// Mermaid 导出
function exportToMermaid(): string {
  let mermaid = "graph TD\n";
  
  // ... 节点定义
  
  // 常规依赖边
  for (const edge of edges.filter(e => e.type !== "cycle")) {
    mermaid += `  ${edge.from} --> ${edge.to}\n`;
  }
  
  // 循环边（虚线）
  for (const edge of edges.filter(e => e.type === "cycle")) {
    mermaid += `  ${edge.from} -.->|cycle x${edge.iteration}| ${edge.to}\n`;
  }
  
  return mermaid;
}
```

---

## 📐 架构影响分析

### 需要修改的文件

| 文件 | 修改内容 | 复杂度 |
|------|---------|--------|
| `dynamicGraphTypes.ts` | 新增 `CycleEdge` 类型，扩展 `NodeStatus` | ⭐ 低 |
| `dynamicGraphEngine.ts` | 集成 `CycleManager`，修改调度逻辑 | ⭐⭐⭐ 中 |
| `cycleManager.ts` | 新建文件，实现循环管理 | ⭐⭐ 中 |
| `dagValidator.ts` | 添加循环边验证逻辑 | ⭐⭐ 低 |
| `graphVisualizer.ts` | 支持循环边可视化 | ⭐⭐ 低 |
| `dynamicWorkflowTools.ts` | 更新工具输入模式 | ⭐ 低 |

### 向后兼容性

✅ **完全兼容**：
- 不提供 `cycles` 字段时，行为与现在完全一致
- Reflection Resolver 继续工作（可选择迁移或共存）

---

## 🧪 验证测试

### 测试用例 1：简单审查-修复循环

```typescript
runDynamicGraph({
  initialNodes: [
    { id: "code", task: "写代码", role: "executor" },
    { id: "review", task: "审查", role: "reviewer", dependsOn: ["code"] },
    { id: "fix", task: "修复", role: "executor", dependsOn: ["review"] }
  ],
  cycles: [
    {
      id: "qa-loop",
      from: "fix",
      to: "review",
      maxIterations: 3,
      breakCondition: "nodes['review'].content.includes('APPROVED')"
    }
  ]
});
```

**预期结果**：
- `code` 执行 1 次
- `review` 执行 2-4 次
- `fix` 执行 1-3 次
- 总节点数：3（不膨胀）

### 测试用例 2：嵌套循环

```typescript
runDynamicGraph({
  initialNodes: [
    { id: "unit-test", task: "单元测试", role: "executor" },
    { id: "debug", task: "调试", role: "executor", dependsOn: ["unit-test"] },
    { id: "integration-test", task: "集成测试", role: "executor", dependsOn: ["debug"] },
    { id: "fix-integration", task: "修复集成问题", role: "executor", dependsOn: ["integration-test"] }
  ],
  cycles: [
    // 内层循环：单元测试 ↔ 调试
    { id: "unit-loop", from: "debug", to: "unit-test", maxIterations: 3 },
    // 外层循环：集成测试 ↔ 修复
    { id: "integration-loop", from: "fix-integration", to: "integration-test", maxIterations: 2 }
  ]
});
```

---

## ⚖️ 利弊权衡

### 优势 ✅

1. **更直观的配置**
   - 一眼看出循环结构
   - 不需要 Resolver 回调

2. **节点数不膨胀**
   - 同一节点重复执行
   - 总节点数 = 初始节点数

3. **更精确的可视化**
   - 循环边用虚线标注
   - 显示迭代次数

4. **灵活的控制**
   - `maxIterations` 硬限制
   - `breakCondition` 动态退出

### 劣势 ❌

1. **调度器复杂度增加**
   - 需要状态重置逻辑
   - 需要循环检测和防护

2. **调试难度上升**
   - 同一节点多次执行
   - 需要追踪迭代历史

3. **潜在的无限循环风险**
   - 如果 `breakCondition` 永不满足
   - 需要硬性 `maxIterations` 保护

4. **执行顺序不确定性**
   - 循环节点与其他节点的并发
   - 需要仔细设计依赖关系

---

## 🚦 实现路线图

### Phase 1: 核心基础设施（1-2天）

- [ ] 定义 `CycleEdge` 类型
- [ ] 实现 `CycleManager` 类
- [ ] 扩展 `NodeStatus` 枚举
- [ ] 单元测试：循环边检测、状态重置

### Phase 2: 调度器集成（2-3天）

- [ ] 修改 `executeNode` 后处理逻辑
- [ ] 修改 `isNodeReady` 支持 `pending-retry`
- [ ] 添加循环触发事件
- [ ] 集成测试：简单循环场景

### Phase 3: 可视化和工具（1天）

- [ ] 更新 `graphVisualizer` 支持循环边
- [ ] 更新 `runDynamicGraph` 工具 schema
- [ ] Mermaid 导出支持虚线

### Phase 4: 高级特性（1-2天）

- [ ] 嵌套循环支持
- [ ] 循环历史追踪
- [ ] 性能优化

### Phase 5: 文档和示例（1天）

- [ ] 更新用户文档
- [ ] 创建示例工作流
- [ ] 迁移指南（Reflection Resolver → Cycles）

**总工期：6-9 天**

---

## 🤔 决策建议

### 立即实现？还是保持现状？

**建议：阶段性实施**

1. **短期（本周）**：
   - 保持现有 Reflection Resolver
   - 创建 POC 原型验证可行性

2. **中期（1-2周）**：
   - 实现 Phase 1-2（核心功能）
   - 与 Reflection Resolver 共存

3. **长期（1个月）**：
   - 完成全部功能
   - 逐步迁移现有用例

### 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 调度器 bug | 中 | 高 | 充分测试 + 快速回滚 |
| 性能下降 | 低 | 中 | 基准测试 + 优化 |
| 用户困惑 | 中 | 低 | 详细文档 + 示例 |
| 无限循环 | 低 | 高 | 硬性 `maxIterations` |

---

## 📝 下一步行动

1. **获得团队共识**
   - 评审本设计文档
   - 讨论实现优先级

2. **创建 POC**
   - 实现最小可行版本
   - 验证核心假设

3. **性能基准测试**
   - 对比 DAG vs 双向图性能
   - 评估节点重置开销

4. **用户反馈**
   - 征集真实使用场景
   - 调整设计细节

---

## 附录：OpenAI Agents SDK 对比

OpenAI 的 Agents SDK **也没有真正的双向图支持**。他们的解决方案：

1. **Handoff 模式**：移交控制权，但不回退
2. **手动循环**：在代码中用 `while` 循环调用 agent

我们的双向图方案将提供比 OpenAI 更强大的编排能力！

---

**结论：双向图是可行的，且能显著提升用户体验。建议分阶段实施。**
