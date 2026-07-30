# 状态驱动动态工作流架构规格

## 目标

将当前由大模型直接生成 `initialNodes/dependsOn/inputMapping/cycles/condition` 的动态工作流，改造成“模型生成语义计划、确定性编译器生成运行图、状态驱动运行时执行”的结构。

第一阶段必须支持：

- 普通依赖图和 `review -> fix -> review` 有向循环。
- 节点在同一个运行步骤读取同一个状态快照。
- 任意节点通过声明的状态通道读取已提交数据。
- 状态写入冲突可检测、可解释、不可静默覆盖。
- 循环在业务状态满足退出条件时结束，并受 `maxSteps` 保护。
- 弱模型生成非法计划时在执行前失败，不猜测、不静默降级。

## 非目标

- 不引入 LangGraph 运行时或新的第三方依赖。
- 第一阶段不实现持久化 checkpoint、时间旅行、暂停恢复和分布式执行。
- 第一阶段不实现任意 JavaScript 表达式、模型自由指定任意跳转或新的动态 `Send` fan-out；已有 resolver 输入必须通过兼容适配器保留。
- 不把 VS Code Webview 变成工作流调度器；调度器继续属于 extension agent runtime。
- 不同时维护“旧循环引擎”和“新状态引擎”两套执行路径。

## 当前问题

当前 `dynamicGraphEngine.ts` 以单个可变 `DynamicNode.result/status` 和 `completedNodes` 作为运行状态，`CycleManager` 通过重置目标节点重新执行。该模型无法表达同一节点的多轮执行，且旧结果可能继续进入新一轮输入。

当前 `dynamicGraphTypes.ts` 把初始节点依赖固定为 DAG，同时用 `cycles` 另行描述回边；`dynamicWorkflowTools.ts` 要求模型生成循环边、循环表达式和表达式语言细节。这个输入契约对弱模型过重，也把业务路由、数据传递和安全校验混在一起。

## 术语

- **语义计划**：模型输出的最小 JSON，只描述节点任务、前置节点、上下文来源和审核关系。
- **编译图**：编译器输出的不可变运行定义，包含节点、合法路由、状态通道和执行限制。
- **扩展规则**：旧 `fanout/conditional/iterative` resolver 转换后的受限运行时规则；它只能在状态提交后新增合法节点，不能直接修改已运行节点。
- **状态通道**：带写入策略的命名数据槽，例如 `outputs.draft`、`outputs.review`。
- **步骤（step）**：一次快照读取、节点执行、写入合并和下一批路由。
- **前沿（frontier）**：当前步骤允许执行的节点集合。

## 模型输入契约

模型只生成以下结构，不生成 `cycles`、表达式或 reducer：

```ts
type GeneratedWorkflowPlan = {
  nodes: GeneratedWorkflowNode[];
  entry?: string[];
  initialState?: Record<string, unknown>;
  maxSteps?: number;
};

type GeneratedWorkflowNode = {
  id: string;
  task: string;
  role?: SubagentRoleId;
  after?: string[];
  contextFrom?: string[];
  reviews?: string[];
};
```

`reviews` 表示当前节点审核哪个节点的输出。审核节点必须是终端节点，或显式声明 `after` 作为审核通过后的后继；编译器为审核节点生成两条受约束路由：审核结果为 `approve` 时进入这些后继、没有后继时进入 `END`；结果为 `revise` 时回到被审核节点。审核结果必须是校验后的结构化对象，不从自然语言中猜测。

## 编译器

`compileGeneratedWorkflow(plan)` 是纯函数，负责：

1. 校验节点 ID 唯一、非空且只包含允许字符。
2. 校验 `after/contextFrom/reviews` 引用已声明节点。
3. 根据 `after` 生成普通有向边，不要求全图无环。
4. 根据 `reviews` 生成审核路由，并拒绝多重审核目标或无法回流的审核节点。
5. 为每个节点分配只读输入通道和命名输出通道 `outputs.<nodeId>`。
6. 为状态通道生成固定写入策略：节点输出使用 `single`，运行历史使用 `append`。
7. 注入 `maxSteps`、单次运行最大节点执行次数和副作用执行串行约束。
8. 输出稳定、可序列化的编译错误，包含字段路径和节点 ID。

编译器不负责执行模型，不调用 VS Code API，不读取可变运行状态。

兼容 resolver 不作为新模型契约暴露。入口适配器把旧 resolver 转成 `expansionRules`，由同一个 superstep 运行时在状态提交后处理；resolver 失败进入图失败事件，不能静默丢弃生成节点。

## 状态和写入

```ts
type WorkflowStateSnapshot = {
  step: number;
  version: number;
  values: ReadonlyMap<string, unknown>;
};

type StateWrite = {
  channel: string;
  value: unknown;
  mode: "single" | "append" | "merge";
  nodeId: string;
};
```

同一步的所有节点只能读取步骤开始时的快照。节点写入在步骤结束时统一提交：

- `single`：同一步只能有一个写入者，冲突报错。
- `append`：按编译图中的稳定节点顺序追加。
- `merge`：只允许对象字段不冲突地合并；重复字段报错。

第一阶段不允许模型定义 reducer，也不允许节点直接修改另一个节点的运行对象。

## 运行时

运行时采用以下固定顺序：

```text
读取 frontier
  -> 创建 snapshot
  -> 并行执行只读节点 / 串行执行副作用节点
  -> 收集 StateWrite
  -> 按策略原子提交
  -> 根据已提交状态解析下一 frontier
  -> step + 1
```

节点执行记录必须包含 `nodeId`、`step`、`attempt`、`status`、`writes` 和错误信息。节点每次循环都是新的执行记录，不能复用上一次的 `result` 或 `subagentId`。

状态负责传递数据，边负责触发执行。某个节点能读取某个状态通道，不代表它会自动执行；只有被 frontier 或合法路由选中才会执行。

## 循环和退出

循环不再由 `cycles` 字段表示。循环由审核节点的结构化状态结果驱动：

```text
draft -> review
review(decision=approve) -> END
review(decision=revise) -> draft
```

无论业务状态如何，运行时都必须执行 `maxSteps` 和 `maxExecutions` 检查。达到上限返回明确的 `GraphLimitExceeded`，不能返回伪成功。

## 兼容策略

旧 `DynamicGraphDefinition` 继续由兼容适配器接受，但只在入口处转换为编译图：

- `dependsOn` 转成 `after`。
- `inputMapping/exportTo` 转成 `contextFrom` 和命名输出。
- 可识别的简单 `cycles` 转成 `reviews` 语义。
- `fanout/conditional/iterative` resolver 转成 `expansionRules`，继续使用同一状态运行时；只有无法安全转换的表达式或跳转才拒绝执行，并提示使用新计划格式。

新语义计划运行时不读取旧 `cycles`，也不依赖 `CycleManager`；旧 `initialNodes/resolvers/cycles` 兼容入口在迁移完成前仍走旧路径，并必须在最终清理任务中单独验收。

## 并发和副作用

只读节点可以在同一步并行；`applyEdit`、`runCommand` 等可能修改工作区的节点第一阶段按步骤串行执行。工作区锁继续保护实际写入，但不能替代状态提交冲突检测。

## 可观测性

保留现有节点事件，新增或调整为步骤语义：`StepStarted`、`StateCommitted`、`StepRouted`、`GraphLimitExceeded`。Webview 第一阶段只显示步骤、节点状态和停止原因，不实现新的图形编辑器。

## 验收标准

1. 弱模型只生成语义计划，不需要知道循环字段或表达式语法。
2. `review-fix` 至少执行两轮时，最终状态和结果只包含最后一次已提交值，历史保留每一轮记录。
3. 两个并行节点读取同一快照；其中一个的写入不会改变另一个本轮读取内容。
4. 同一步单写通道冲突会失败，不能依赖 Promise 完成顺序。
5. 状态没有达到结束条件时，`maxSteps` 能阻止无限循环。
6. 旧 DAG 调用保持可用；不支持安全转换的旧循环明确失败。
7. `npm test`、`npm run typecheck`、`npm run compile` 和同一 Extension Development Host 中的真实 `runDynamicGraph` 路径通过。
