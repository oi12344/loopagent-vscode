# 动态循环控制机制 - 改进设计

**日期**: 2026-07-30  
**基于**: 双向图设计方案

---

## 🎯 核心问题

**写死循环次数的局限：**
- 任务复杂度不可预测
- 可能过早放弃（实际需要更多轮）
- 可能浪费资源（实际已经完成）

---

## 💡 改进方案

### 方案 1：多条件退出（推荐）⭐

```typescript
export type CycleExitStrategy = {
  // 多个退出条件，任一满足即退出
  conditions: Array<{
    type: "max-iterations" | "expression" | "no-progress" | "cost-limit" | "time-limit";
    value?: any;
    description?: string;
  }>;
  
  // 默认策略（当所有条件都未满足时）
  defaultAction: "continue" | "stop";
};

export type CycleEdge = {
  id: string;
  from: DynamicNodeId;
  to: DynamicNodeId;
  exitStrategy: CycleExitStrategy;  // 👈 替代 maxIterations + breakCondition
};
```

**使用示例：**

```typescript
cycles: [
  {
    id: "review-fix-loop",
    from: "fix",
    to: "review",
    exitStrategy: {
      conditions: [
        // 条件1：审查通过
        {
          type: "expression",
          value: "nodes['review'].content.includes('APPROVED')",
          description: "审查通过"
        },
        
        // 条件2：软上限（警告但可继续）
        {
          type: "max-iterations",
          value: 5,
          description: "已尝试 5 轮"
        },
        
        // 条件3：无进展检测
        {
          type: "no-progress",
          value: 2,  // 连续 2 轮输出相同
          description: "修复无进展"
        },
        
        // 条件4：成本控制
        {
          type: "cost-limit",
          value: 100000,  // 累计 token 数
          description: "超出预算"
        }
      ],
      defaultAction: "continue"  // 默认继续
    }
  }
]
```

---

### 方案 2：自适应循环（智能）🤖

```typescript
export type AdaptiveCycleConfig = {
  // 基础配置
  softLimit: number;      // 软上限（建议停止）
  hardLimit: number;      // 硬上限（强制停止）
  
  // 自适应策略
  progressDetection: {
    enabled: boolean;
    window: number;       // 检测窗口（最近 N 轮）
    threshold: number;    // 进展阈值（0-1）
  };
  
  // 质量评估
  qualityCheck?: {
    evaluator: string;    // 表达式或函数
    minimumScore: number; // 最低质量分数
  };
  
  // 成本意识
  costAware?: {
    tokenBudget: number;
    stopIfExceeded: boolean;
  };
};

export type CycleEdge = {
  id: string;
  from: DynamicNodeId;
  to: DynamicNodeId;
  adaptive: AdaptiveCycleConfig;  // 👈 智能配置
};
```

**使用示例：**

```typescript
cycles: [
  {
    id: "review-fix-loop",
    from: "fix",
    to: "review",
    adaptive: {
      softLimit: 3,      // 建议 3 轮内完成
      hardLimit: 10,     // 最多 10 轮
      
      progressDetection: {
        enabled: true,
        window: 2,       // 检查最近 2 轮
        threshold: 0.1   // 如果改进 < 10%，停止
      },
      
      qualityCheck: {
        evaluator: `
          const issues = nodes['review'].content.match(/问题\\d+/g);
          return issues ? issues.length : 0;
        `,
        minimumScore: 0  // 0 个问题
      },
      
      costAware: {
        tokenBudget: 50000,
        stopIfExceeded: true
      }
    }
  }
]
```

**执行逻辑：**

```typescript
// 每轮结束后评估
async function shouldContinueCycle(
  cycleState: CycleState,
  context: GraphComputationContext
): Promise<{ continue: boolean; reason: string }> {
  
  const config = cycleState.edge.adaptive;
  
  // 1. 硬上限检查（强制）
  if (cycleState.currentIteration >= config.hardLimit) {
    return { 
      continue: false, 
      reason: `达到硬上限 ${config.hardLimit} 轮` 
    };
  }
  
  // 2. 质量检查（如果配置）
  if (config.qualityCheck) {
    const score = evaluateQuality(config.qualityCheck, context);
    if (score <= config.qualityCheck.minimumScore) {
      return { 
        continue: false, 
        reason: `质量达标 (score: ${score})` 
      };
    }
  }
  
  // 3. 成本检查
  if (config.costAware) {
    const totalTokens = calculateCycleTokens(cycleState);
    if (totalTokens > config.costAware.tokenBudget) {
      if (config.costAware.stopIfExceeded) {
        return { 
          continue: false, 
          reason: `超出 token 预算 (${totalTokens}/${config.costAware.tokenBudget})` 
        };
      } else {
        console.warn(`[Cycle ${cycleState.edge.id}] 超出预算但继续`);
      }
    }
  }
  
  // 4. 进展检测
  if (config.progressDetection.enabled) {
    const hasProgress = detectProgress(cycleState, config.progressDetection);
    if (!hasProgress) {
      return { 
        continue: false, 
        reason: `连续 ${config.progressDetection.window} 轮无明显进展` 
      };
    }
  }
  
  // 5. 软上限警告
  if (cycleState.currentIteration >= config.softLimit) {
    console.warn(
      `[Cycle ${cycleState.edge.id}] 已超过建议轮数 ${config.softLimit}，当前第 ${cycleState.currentIteration} 轮`
    );
  }
  
  return { continue: true, reason: "继续优化" };
}
```

---

### 方案 3：用户交互式批准（混合）👤

```typescript
export type InteractiveCycleConfig = {
  // 自动运行配置
  autoRunRounds: number;  // 自动运行 N 轮
  
  // 之后每轮询问用户
  askUserAfter: number;
  
  // 或基于条件询问
  askUserIf?: string;  // 表达式
};

export type CycleEdge = {
  id: string;
  from: DynamicNodeId;
  to: DynamicNodeId;
  interactive: InteractiveCycleConfig;
};
```

**使用示例：**

```typescript
cycles: [
  {
    id: "review-fix-loop",
    from: "fix",
    to: "review",
    interactive: {
      autoRunRounds: 3,  // 自动运行 3 轮
      askUserAfter: 3,   // 第 4 轮开始询问用户
      askUserIf: "nodes['review'].content.length > 1000"  // 或审查意见很长时询问
    }
  }
]
```

**执行时的用户提示：**

```
🔄 循环 "review-fix-loop" 已运行 3 轮

最近一轮结果：
- review: 发现 2 个中等优先级问题
- fix: 已修复 1 个问题

是否继续下一轮？
  [继续] [停止] [再运行 2 轮后询问]
```

---

## 🎨 推荐的综合方案

**结合多种策略的灵活配置：**

```typescript
export type CycleExitConfig = {
  // 基础上限（必选）
  hardLimit: number;
  
  // 主要退出条件（可选，满足任一即退出）
  breakWhen?: Array<{
    condition: string;       // 表达式
    description: string;     // 人类可读描述
    priority: "high" | "medium" | "low";
  }>;
  
  // 自适应检测（可选）
  adaptive?: {
    detectNoProgress: boolean;
    progressWindow: number;
    costBudget?: number;
  };
  
  // 用户交互（可选）
  interactive?: {
    askAfterRound: number;
    showProgressSummary: boolean;
  };
};
```

**完整示例：**

```typescript
runDynamicGraph({
  initialNodes: [
    { id: "implement", task: "实现功能", role: "executor" },
    { id: "review", task: "审查代码", role: "reviewer", dependsOn: ["implement"] },
    { id: "fix", task: "修复问题", role: "executor", dependsOn: ["review"] }
  ],
  
  cycles: [
    {
      id: "qa-loop",
      from: "fix",
      to: "review",
      exit: {
        hardLimit: 10,  // 绝对上限
        
        // 主要退出条件
        breakWhen: [
          {
            condition: "nodes['review'].content.includes('APPROVED')",
            description: "代码审查通过",
            priority: "high"
          },
          {
            condition: "nodes['review'].content.match(/问题/g)?.length === 0",
            description: "没有发现任何问题",
            priority: "high"
          },
          {
            condition: "cycleState.currentIteration >= 5 && nodes['review'].content.length < 200",
            description: "5 轮后审查意见很简短（可能已接近完成）",
            priority: "medium"
          }
        ],
        
        // 自适应检测
        adaptive: {
          detectNoProgress: true,
          progressWindow: 2,
          costBudget: 50000  // token 预算
        },
        
        // 用户交互（可选）
        interactive: {
          askAfterRound: 5,  // 第 6 轮开始询问
          showProgressSummary: true
        }
      }
    }
  ]
});
```

---

## 🔧 实现细节

### CycleManager 增强

```typescript
export class CycleManager {
  async shouldContinue(
    cycleId: string,
    context: GraphComputationContext,
    completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>
  ): Promise<CycleDecision> {
    
    const state = this.cycles.get(cycleId);
    const config = state.edge.exit;
    
    // 1. 硬上限检查
    if (state.currentIteration >= config.hardLimit) {
      return {
        continue: false,
        reason: `达到硬上限 ${config.hardLimit}`,
        severity: "info"
      };
    }
    
    // 2. 主要退出条件
    if (config.breakWhen) {
      for (const rule of config.breakWhen) {
        const satisfied = dataFlowManager.evaluateExpression(
          rule.condition,
          { nodes: completedNodes, globalData: context.globalData, cycleState: state }
        );
        
        if (satisfied) {
          return {
            continue: false,
            reason: rule.description,
            severity: rule.priority === "high" ? "success" : "info"
          };
        }
      }
    }
    
    // 3. 自适应检测
    if (config.adaptive?.detectNoProgress) {
      const hasProgress = this.detectProgress(state, config.adaptive.progressWindow);
      if (!hasProgress) {
        return {
          continue: false,
          reason: `连续 ${config.adaptive.progressWindow} 轮无明显进展`,
          severity: "warning"
        };
      }
    }
    
    // 4. 成本检查
    if (config.adaptive?.costBudget) {
      const totalCost = this.calculateCycleCost(state);
      if (totalCost > config.adaptive.costBudget) {
        return {
          continue: false,
          reason: `超出 token 预算 (${totalCost}/${config.adaptive.costBudget})`,
          severity: "warning"
        };
      }
    }
    
    // 5. 用户交互
    if (config.interactive?.askAfterRound && 
        state.currentIteration >= config.interactive.askAfterRound) {
      const userDecision = await this.askUserToContinue(state, context);
      if (!userDecision.continue) {
        return {
          continue: false,
          reason: "用户选择停止",
          severity: "info"
        };
      }
    }
    
    return { continue: true, reason: "继续优化" };
  }
  
  private detectProgress(state: CycleState, window: number): boolean {
    if (state.history.length < window + 1) return true;
    
    const recent = state.history.slice(-window);
    const previous = state.history.slice(-window - 1, -1);
    
    // 比较最近几轮的输出相似度
    // 如果高度相似（> 90%），认为无进展
    const similarity = this.calculateSimilarity(
      recent.map(h => h.toNodeResult?.content),
      previous.map(h => h.toNodeResult?.content)
    );
    
    return similarity < 0.9;
  }
  
  private calculateSimilarity(a: (string | undefined)[], b: (string | undefined)[]): number {
    // 简单的相似度计算（可以用更复杂的算法）
    // 实现略
    return 0;
  }
}
```

---

## 📊 配置对比

| 策略 | 灵活性 | 自动化程度 | 用户干预 | 适用场景 |
|------|--------|----------|---------|---------|
| **写死次数** | ⭐ | ⭐⭐⭐ | 无 | 简单、可预测的任务 |
| **多条件退出** | ⭐⭐⭐ | ⭐⭐⭐ | 无 | 复杂但明确的退出条件 |
| **自适应循环** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 无 | 不可预测的复杂任务 |
| **交互式** | ⭐⭐⭐⭐⭐ | ⭐⭐ | 高 | 关键任务，需要人工监督 |
| **综合方案** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 可选 | **推荐：覆盖所有场景** |

---

## 🎯 最终推荐

### 默认配置（简单场景）

```typescript
cycles: [
  {
    id: "review-fix",
    from: "fix",
    to: "review",
    exit: {
      hardLimit: 10,
      breakWhen: [
        { condition: "nodes['review'].content.includes('APPROVED')" }
      ]
    }
  }
]
```

### 高级配置（复杂场景）

```typescript
cycles: [
  {
    id: "review-fix",
    from: "fix",
    to: "review",
    exit: {
      hardLimit: 20,
      breakWhen: [
        { condition: "审查通过表达式", priority: "high" },
        { condition: "问题数量为 0", priority: "high" },
        { condition: "改进幅度小于阈值", priority: "medium" }
      ],
      adaptive: {
        detectNoProgress: true,
        progressWindow: 2,
        costBudget: 100000
      },
      interactive: {
        askAfterRound: 10
      }
    }
  }
]
```

---

## 结论

**去掉写死的 `maxIterations`，采用综合退出策略：**

✅ **灵活**：适应不同复杂度的任务  
✅ **智能**：自动检测无进展  
✅ **安全**：硬上限 + 成本控制  
✅ **可控**：可选的用户交互  

这比简单的 `maxIterations: 3` 强大得多！
