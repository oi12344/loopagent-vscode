# 依赖解析器（Dependency Resolver）详解

## 概念定义

**依赖解析器（DependencyResolver）** 是一个回调函数，在特定节点完成执行后被调用，用于**动态生成新的工作流节点**。

### 类型签名

```typescript
type DependencyResolver = (
    nodeId: DynamicNodeId,                              // 刚完成的节点 ID
    completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>,  // 所有已完成节点的结果
    context: GraphComputationContext                     // 工作流全局上下文
) => Promise<DynamicNodeConfig[]>;                      // 返回要生成的新节点配置数组
```

---

## 核心作用

### 1. 运行时决策 - 根据执行结果动态扩展图

**静态定义 vs 动态扩展**：

```typescript
// ❌ 静态定义：必须预先知道所有节点
const definition = {
    initialNodes: [
        { id: "scan", task: "扫描文件" },
        { id: "analyze_A", task: "分析 A.ts" },  // 预先硬编码
        { id: "analyze_B", task: "分析 B.ts" },  // 预先硬编码
        // ... 如果文件数量未知？
    ]
};

// ✅ 动态扩展：根据扫描结果生成节点
const definition = {
    initialNodes: [
        { id: "scan", task: "扫描文件" }
    ],
    resolvers: new Map([
        ["scan", async (nodeId, completedNodes) => {
            const scanResult = completedNodes.get("scan");
            const files = JSON.parse(scanResult.content);  // ["A.ts", "B.ts", "C.ts", ...]
            
            // 🔄 根据实际扫描结果动态生成分析节点
            return files.map(file => ({
                id: `analyze_${file}`,
                task: `分析文件 ${file}`,
                role: "reviewer"
            }));
        }]
    ])
};
```

**执行流程**：
```
T0: scan 节点启动
T1: scan 完成 → 发现 50 个文件
T2: 调用 scan 的 resolver → 生成 50 个 analyze_* 节点
T3: 50 个 analyze_* 节点并行执行
```

---

## 典型应用场景

### 场景 1：批量并行处理（Fan-out）

**问题**：在执行前不知道要处理的数据量。

**解决方案**：
```typescript
resolvers.set("fetch_user_list", async (nodeId, completed) => {
    const result = completed.get("fetch_user_list");
    const userIds = JSON.parse(result.content);  // [101, 102, 103, ...]
    
    // 🌟 为每个用户生成一个处理节点
    return userIds.map(id => ({
        id: `process_user_${id}`,
        task: `处理用户 ${id} 的数据`,
        role: "explorer",
        inputMapping: {
            userId: `"${id}"`  // 传递用户 ID
        }
    }));
});
```

**生成的图结构**：
```
fetch_user_list (完成)
    ↓
    ├─→ process_user_101 (并行)
    ├─→ process_user_102 (并行)
    ├─→ process_user_103 (并行)
    └─→ ...
```

---

### 场景 2：条件分支（Conditional Branching）

**问题**：根据节点执行结果决定后续路径。

**解决方案**：
```typescript
resolvers.set("health_check", async (nodeId, completed) => {
    const checkResult = completed.get("health_check");
    const status = JSON.parse(checkResult.content);
    
    if (status.healthy) {
        // ✅ 健康 → 执行正常部署流程
        return [
            { id: "deploy_staging", task: "部署到 Staging 环境" },
            { id: "run_smoke_tests", task: "运行冒烟测试" }
        ];
    } else {
        // ❌ 不健康 → 执行修复流程
        return [
            { id: "rollback", task: "回滚到上一个版本" },
            { id: "notify_oncall", task: "通知值班人员", role: "planner" }
        ];
    }
});
```

**生成的图结构（分支 A）**：
```
health_check (completed, healthy: true)
    ↓
    ├─→ deploy_staging
    └─→ run_smoke_tests
```

**生成的图结构（分支 B）**：
```
health_check (completed, healthy: false)
    ↓
    ├─→ rollback
    └─→ notify_oncall
```

---

### 场景 3：迭代优化（Iterative Refinement）

**问题**：需要重复执行直到满足条件（需要扩展支持循环）。

**解决方案（概念示例，当前架构不完全支持）**：
```typescript
resolvers.set("optimize_model", async (nodeId, completed, context) => {
    const optimizeResult = completed.get(nodeId);
    const metrics = JSON.parse(optimizeResult.content);
    
    // 读取迭代计数器
    const iteration = (context.globalData.get("iteration") as number) || 0;
    
    if (metrics.accuracy < 0.95 && iteration < 10) {
        // 🔁 未收敛 → 继续优化
        context.globalData.set("iteration", iteration + 1);
        return [
            {
                id: `optimize_model_iter${iteration + 1}`,
                task: `优化模型参数 (迭代 ${iteration + 1})`,
                inputMapping: {
                    previousScore: `${nodeId}.content.accuracy`,
                    iteration: `$iteration`
                }
            }
        ];
    } else {
        // ✅ 收敛或达到最大迭代次数 → 完成
        return [
            {
                id: "save_final_model",
                task: "保存最终模型"
            }
        ];
    }
});
```

**生成的图结构**：
```
optimize_model_iter0 (accuracy: 0.80)
    ↓
optimize_model_iter1 (accuracy: 0.88)
    ↓
optimize_model_iter2 (accuracy: 0.93)
    ↓
optimize_model_iter3 (accuracy: 0.96) → 收敛
    ↓
save_final_model
```

---

### 场景 4：多阶段汇聚（Phased Aggregation）

**问题**：需要先并行处理，再汇总结果。

**解决方案**：
```typescript
// 第一阶段：扫描生成分析节点
resolvers.set("scan_modules", async (nodeId, completed) => {
    const modules = JSON.parse(completed.get("scan_modules").content);
    return modules.map(mod => ({
        id: `analyze_${mod}`,
        task: `分析模块 ${mod}`
    }));
});

// 第二阶段：所有分析完成后生成汇总节点
resolvers.set("analyze_auth", async (nodeId, completed) => {
    // 检查是否所有分析节点都完成
    const allAnalysisNodes = Array.from(completed.keys())
        .filter(id => id.startsWith("analyze_"));
    
    const scanResult = completed.get("scan_modules");
    const totalModules = JSON.parse(scanResult.content).length;
    
    if (allAnalysisNodes.length === totalModules) {
        // ✅ 所有分析完成 → 生成汇总节点
        return [
            {
                id: "aggregate_results",
                task: "汇总所有分析结果",
                inputMapping: {
                    // 收集所有分析节点的输出
                    ...Object.fromEntries(
                        allAnalysisNodes.map(id => [id, `${id}.content`])
                    )
                }
            }
        ];
    }
    
    return [];  // 其他节点还未完成，不生成汇总节点
});
```

**生成的图结构**：
```
scan_modules
    ↓
    ├─→ analyze_auth ────┐
    ├─→ analyze_db ──────┤
    └─→ analyze_api ─────┤
                         ↓
                  aggregate_results (等待所有 analyze_* 完成)
```

---

## 实现机制

### 注册方式

**方式 1：创建引擎时硬编码（当前唯一可行方式）**：

```typescript
const definition: DynamicGraphDefinition = {
    initialNodes: [
        { id: "scan", task: "扫描文件" }
    ],
    resolvers: new Map([
        ["scan", async (nodeId, completed, context) => {
            // resolver 实现
            return [...];
        }]
    ])
};

const engine = createDynamicGraphEngine({ definition, ... });
```

**方式 2：通过工具注册（⚠️ 当前未实现）**：

```typescript
// dynamicWorkflowTools.ts:108-142
{
    name: "addDynamicResolver",
    invoke({ input }) {
        // TODO: Implement resolver based on type
        // 当前仅返回占位结果，未实际注册
    }
}
```

---

### 执行时机

[dynamicGraphEngine.ts:166-208](src/extension/agent/workflow/dynamicGraphEngine.ts#L166-L208)

```typescript
async function executeNode(node: DynamicNode, completedNodes) {
    // 1. 创建并等待子智能体执行
    const subagentId = orchestrator.createSubagent({...}, availableTools);
    const results = await orchestrator.waitForSubagents([subagentId]);
    const result = results.get(subagentId);
    
    if (result) {
        // 2. 记录节点结果
        node.result = result;
        updateNodeStatus(node.config.id, "completed");
        
        const newCompletedNodes = new Map(completedNodes);
        newCompletedNodes.set(node.config.id, result);
        
        // 3. 🔑 调用依赖解析器（如果存在）
        await resolveDependencies(node.config.id, newCompletedNodes);
    }
}
```

[dynamicGraphEngine.ts:210-231](src/extension/agent/workflow/dynamicGraphEngine.ts#L210-L231)

```typescript
async function resolveDependencies(nodeId, completedNodes) {
    const resolver = definition.resolvers?.get(nodeId);
    if (!resolver) return;  // 🚫 无 resolver 则跳过
    
    try {
        // 4. 调用用户定义的 resolver 函数
        const newNodeConfigs = await resolver(nodeId, completedNodes, context);
        if (newNodeConfigs.length === 0) return;
        
        // 5. 将生成的节点加入图
        for (const config of newNodeConfigs) {
            const id = addNode(config, [nodeId]);  // 新节点依赖当前节点
        }
        
        emit({ type: "DependenciesResolved", nodeId, newNodes: newNodeConfigs });
    } catch (error) {
        console.error(`Failed to resolve dependencies for node ${nodeId}:`, error);
    }
}
```

**执行顺序**：
```
节点 A 执行完成
    ↓
调用 resolver A
    ↓
生成新节点 B1, B2, B3
    ↓
B1, B2, B3 加入图（状态 = pending，依赖 = [A]）
    ↓
主调度循环检测到 B1, B2, B3 就绪
    ↓
并行执行 B1, B2, B3
```

---

## Resolver 的输入参数

### 1. `nodeId: DynamicNodeId`

**含义**：刚完成的节点 ID。

**用途**：
- 标识是哪个节点的 resolver 被触发
- 从 `completedNodes` 中提取该节点的结果

```typescript
resolvers.set("scan", async (nodeId, completedNodes) => {
    console.log(nodeId);  // "scan"
    const result = completedNodes.get(nodeId);  // 获取 scan 节点的结果
});
```

---

### 2. `completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>`

**含义**：所有已完成节点的结果集合。

**结构**：
```typescript
Map {
    "scan" => {
        status: "completed",
        content: "[\"fileA.ts\", \"fileB.ts\"]",
        toolCallCount: 5
    },
    "validate" => {
        status: "completed",
        content: "验证通过"
    }
}
```

**用途**：
- 读取当前节点的输出：`completedNodes.get(nodeId).content`
- 读取依赖节点的输出：`completedNodes.get("dependency_node_id")`
- 基于多个节点的结果做决策

**示例**：
```typescript
resolvers.set("summarize", async (nodeId, completedNodes) => {
    // 读取多个前置节点的结果
    const analysis1 = completedNodes.get("analyze_module_A").content;
    const analysis2 = completedNodes.get("analyze_module_B").content;
    
    if (analysis1.includes("ERROR") || analysis2.includes("ERROR")) {
        return [{ id: "emergency_fix", task: "紧急修复" }];
    }
    return [{ id: "deploy", task: "正常部署" }];
});
```

---

### 3. `context: GraphComputationContext`

**含义**：工作流的全局上下文。

**结构**：
```typescript
type GraphComputationContext = {
    nodes: Map<DynamicNodeId, DynamicNode>;  // 所有节点（包括 pending）
    globalData: Map<string, unknown>;         // 全局共享数据
    executionOrder: DynamicNodeId[];          // 已执行节点的顺序
};
```

**用途**：

#### 3.1 访问所有节点状态
```typescript
resolvers.set("check_progress", async (nodeId, completed, context) => {
    const totalNodes = context.nodes.size;
    const completedCount = completed.size;
    
    console.log(`进度: ${completedCount}/${totalNodes}`);
    
    if (completedCount / totalNodes > 0.5) {
        return [{ id: "mid_point_report", task: "生成中期报告" }];
    }
    return [];
});
```

#### 3.2 读写全局数据
```typescript
resolvers.set("process_batch", async (nodeId, completed, context) => {
    // 读取计数器
    const processed = (context.globalData.get("processed_count") as number) || 0;
    
    // 更新计数器
    context.globalData.set("processed_count", processed + 1);
    
    if (processed >= 10) {
        return [{ id: "finalize", task: "完成处理" }];
    }
    
    // 继续处理下一批
    return [{
        id: `process_batch_${processed + 1}`,
        task: `处理批次 ${processed + 1}`
    }];
});
```

#### 3.3 检查执行顺序
```typescript
resolvers.set("node_X", async (nodeId, completed, context) => {
    // 查看哪些节点已经执行过
    console.log("执行顺序:", context.executionOrder);
    // ["scan", "validate", "node_X"]
});
```

---

## Resolver 的返回值

### 返回类型

```typescript
Promise<DynamicNodeConfig[]>
```

### `DynamicNodeConfig` 结构

```typescript
type DynamicNodeConfig = {
    id: DynamicNodeId;               // 必需：节点唯一 ID
    task: string;                    // 必需：任务描述
    role?: SubagentRoleId;           // 可选：角色（explorer/reviewer/planner）
    toolHints?: string[];            // 可选：工具提示
    timeoutMs?: number;              // 可选：超时时间
    inputMapping?: Record<string, string>;  // 可选：输入映射
    condition?: NodeCondition;       // 可选：执行条件
};
```

### 返回值的处理

**空数组**：
```typescript
return [];  // 不生成任何新节点
```

**单个节点**：
```typescript
return [
    { id: "next_step", task: "执行下一步" }
];
```

**多个节点（并行执行）**：
```typescript
return [
    { id: "step_A", task: "步骤 A" },
    { id: "step_B", task: "步骤 B" },
    { id: "step_C", task: "步骤 C" }
];
// step_A, step_B, step_C 都依赖当前节点，会并行执行
```

### 生成节点的依赖关系

**自动依赖**：resolver 生成的所有节点会自动依赖触发该 resolver 的节点。

[dynamicGraphEngine.ts:223](src/extension/agent/workflow/dynamicGraphEngine.ts#L223)

```typescript
const id = addNode(config, [nodeId]);  // 第二个参数是依赖列表
```

**示例**：
```typescript
resolvers.set("scan", async (nodeId) => {
    return [
        { id: "analyze_A", task: "分析 A" },
        { id: "analyze_B", task: "分析 B" }
    ];
});

// 生成的图结构：
// scan (completed)
//   ↓
//   ├─→ analyze_A (依赖 scan)
//   └─→ analyze_B (依赖 scan)
```

**⚠️ 当前限制**：
- 无法指定生成节点之间的依赖关系（如 B 依赖 A）
- 所有生成节点都是平级并行的
- 如需串行，必须通过链式 resolver 实现

---

## 当前实现的限制

### 1. 无法通过工具动态添加 Resolver

**问题**：`addDynamicResolver` 工具未实现。

[dynamicWorkflowTools.ts:108-142](src/extension/agent/dynamicWorkflowTools.ts#L108-L142)

```typescript
{
    name: "addDynamicResolver",
    invoke({ input }) {
        // TODO: Implement resolver based on type
        return JSON.stringify({ registered: true });  // 假返回
    }
}
```

**影响**：
- 主智能体无法在运行时注册 resolver
- Resolver 必须在创建引擎前硬编码
- 工具层无法传递 JavaScript 函数（只能传递 JSON）

**解决方案**：
需要实现预定义的 resolver 模板（如 `fanout`, `conditional`, `iterative`），通过配置参数化：

```typescript
{
    resolverType: "fanout",
    resolverConfig: {
        sourceField: "files",           // 从 nodeId.content.files 读取数组
        taskTemplate: "分析文件 {item}", // 任务模板
        nodeIdPrefix: "analyze_"         // 节点 ID 前缀
    }
}
```

---

### 2. 生成节点的依赖关系受限

**问题**：生成的所有节点都自动依赖触发节点，无法指定节点间依赖。

**当前行为**：
```typescript
return [
    { id: "fetch_data", task: "获取数据" },
    { id: "process_data", task: "处理数据" }
];

// 生成的图：
// current_node
//   ├─→ fetch_data (并行)
//   └─→ process_data (并行)
```

**期望行为**：
```typescript
return [
    { id: "fetch_data", task: "获取数据" },
    { id: "process_data", task: "处理数据", dependencies: ["fetch_data"] }  // ⚠️ 不支持
];

// 期望的图：
// current_node
//   ↓
// fetch_data
//   ↓
// process_data
```

**解决方案**：
扩展 `DynamicNodeConfig` 支持 `dependencies` 字段，修改 `addNode` 逻辑。

---

### 3. 缺乏循环控制

**问题**：无法实现"重复执行直到收敛"的模式。

**当前限制**：
- 每次 resolver 返回的节点必须有唯一 ID
- 无法生成"指向自己"的依赖（会违反 DAG 约束）

**解决方案**：
需要架构层面支持循环，例如：
```typescript
{
    id: "optimize",
    task: "优化参数",
    loopCondition: {
        maxIterations: 10,
        exitExpression: "score > 0.95"
    }
}
```

---

## 最佳实践

### 1. 幂等性

Resolver 应该是幂等的（相同输入产生相同输出）：

```typescript
// ✅ 好：基于节点结果的确定性逻辑
resolvers.set("scan", async (nodeId, completed) => {
    const files = JSON.parse(completed.get(nodeId).content);
    return files.map(f => ({ id: `analyze_${f}`, task: `分析 ${f}` }));
});

// ❌ 坏：依赖外部状态或随机性
resolvers.set("scan", async (nodeId, completed) => {
    const randomCount = Math.random() > 0.5 ? 5 : 10;  // 不确定
    return Array.from({ length: randomCount }, (_, i) => ({
        id: `task_${i}`,
        task: "随机任务"
    }));
});
```

---

### 2. 防止节点爆炸

限制生成的节点数量：

```typescript
resolvers.set("scan", async (nodeId, completed, context) => {
    const files = JSON.parse(completed.get(nodeId).content);
    
    // ⚠️ 防御性检查
    if (files.length > 100) {
        console.warn(`文件数量过多 (${files.length})，限制为 100`);
        files.splice(100);
    }
    
    // 检查是否接近图容量上限
    const remainingCapacity = (context.nodes.size - 200) || 50;
    const toGenerate = Math.min(files.length, remainingCapacity);
    
    return files.slice(0, toGenerate).map(f => ({
        id: `analyze_${f}`,
        task: `分析 ${f}`
    }));
});
```

---

### 3. 错误处理

Resolver 中的异常会被捕获但不会中止工作流：

[dynamicGraphEngine.ts:228-230](src/extension/agent/workflow/dynamicGraphEngine.ts#L228-L230)

```typescript
try {
    const newNodeConfigs = await resolver(nodeId, completedNodes, context);
    // ...
} catch (error) {
    console.error(`Failed to resolve dependencies for node ${nodeId}:`, error);
    // 继续执行，不抛出异常
}
```

**建议**：
```typescript
resolvers.set("risky_resolver", async (nodeId, completed) => {
    try {
        const data = JSON.parse(completed.get(nodeId).content);
        return data.items.map(item => ({
            id: `process_${item.id}`,
            task: `处理 ${item.name}`
        }));
    } catch (error) {
        // 返回错误处理节点
        return [{
            id: "handle_parse_error",
            task: `处理解析错误: ${error.message}`,
            role: "planner"
        }];
    }
});
```

---

### 4. 使用全局数据共享状态

跨节点传递状态：

```typescript
// 第一个 resolver：初始化状态
resolvers.set("init", async (nodeId, completed, context) => {
    context.globalData.set("processed_items", []);
    return [{ id: "batch_1", task: "处理批次 1" }];
});

// 后续 resolver：累积状态
resolvers.set("batch_1", async (nodeId, completed, context) => {
    const processedItems = context.globalData.get("processed_items") as string[];
    const batchResult = JSON.parse(completed.get(nodeId).content);
    
    // 更新全局状态
    processedItems.push(...batchResult.items);
    context.globalData.set("processed_items", processedItems);
    
    if (processedItems.length >= 100) {
        return [{ id: "finalize", task: "完成处理" }];
    }
    
    return [{ id: "batch_2", task: "处理批次 2" }];
});
```

---

## 总结

**依赖解析器（DependencyResolver）的核心价值**：

1. **延迟决策**：在执行时根据实际结果决定后续步骤，而非预先定义所有路径
2. **动态扩展**：处理数量未知的批量任务（如文件列表、用户列表）
3. **条件分支**：根据执行结果选择不同的后续流程
4. **适应性**：工作流可以根据中间结果自我调整

**当前限制**：

- ✅ 概念清晰，类型定义完善
- ✅ 执行机制已实现
- ❌ 无法通过工具动态注册（`addDynamicResolver` 未实现）
- ❌ 生成节点的依赖关系受限（仅支持平行扇出）
- ❌ 缺乏循环控制机制

**实际使用方式**：

目前只能在创建引擎时硬编码 resolver，无法通过主智能体的工具调用动态添加。如果需要动态工作流能力，需要实现预定义的 resolver 模板系统。
