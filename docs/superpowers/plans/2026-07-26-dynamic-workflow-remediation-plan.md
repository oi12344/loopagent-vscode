# 动态工作流整改计划

> 依据：[hermes-vs-loopagent-self-evolution.md](../analysis/hermes-vs-loopagent-self-evolution.md) 与 2026-07-26 动态图引擎缺口分析。
> 原则：按"解锁能力"排序而非按严重度排序——先通数据流，再通可靠性，最后补调度与进化能力。

## 状态：✅ 全部完成（2026-07-26）

T1–T11 共 11 项任务全部实现并通过测试验证：
- `npx vitest run test/dynamicGraphWorkflow.test.ts`：27/27（新增 22 个针对性测试）
- `npx vitest run test/agent/workflowOrchestratorMemory.test.ts`（T11 新增）：5/5
- 全量测试：590/592（唯二失败为无关的既有 vision 集成问题）
- `npx tsc --noEmit`：本次改动涉及文件无错误

实现过程中额外发现并修复了 3 个整改计划外的真实 bug：
1. `graphVisualizer.ts` 的 `duration`/`timeline`/`criticalPath` 权重全部依赖从未被赋值的 `node.context.startedAt/finishedAt` 字段，整个耗时分析功能是空转的——已改为 `DynamicNode` 上独立的 `startedAt`/`finishedAt` 字段。
2. `WorkflowOrchestrator.schedule()` 的就绪判定只接受 `status === "completed"`，导致 `dynamicGraphEngine.ts` 里"失败后创建 onFailure 恢复节点"的场景会永久死锁（`waitForSubagents` 永不resolve）——已改为 `dynamicGraphEngine.ts` 不再向底层编排器转发 `dependsOn`（引擎自身的 `readyNodes` 门控已经保证了执行顺序，转发反而引入编排器自己的级联取消语义冲突）。
3. `readyNodes` 过滤器与 `evaluateCondition` 原本只接受 `completed`/`skipped` 为终态，导致依赖失败的下游节点永远卡在 `pending`，`onFailure` 条件分支实质是死代码。

## 总览

| 阶段 | 主题 | 任务 | 预估 | 实际状态 | 出口条件 |
|------|------|------|------|---------|---------|
| P0 | 数据流打通 | T1–T2 | ~1 天 | ✅ 完成 | 节点间数据真实到达子代理 prompt；条件路由可用 |
| P1 | 可靠性 | T3–T5 | ~2 天 | ✅ 完成 | 失败可见、可传播；静态起始 DAG 可定义 |
| P2 | 调度与完整度 | T6–T9 | ~2.5 天 | ✅ 完成 | 连续调度；取消/重试语义完整 |
| P3 | 进化能力衔接 | T10–T11 | ~3 天 | ✅ 完成 | 反思循环可表达；子代理经验入库 |

任务依赖：T1 → T10；T2 → T10；T3 → T9；T5 独立；T11 需先修订规范。

---

## P0：数据流打通（阻塞一切协作场景）

### T1. inputMapping 注入子代理 prompt

**问题**：`prepareNodeInput()` 算出的上游数据只存 `node.context` 并记录到 dataFlowManager，`createSubagent` 只传原始 `task` 文本，LLM 看不到上游结果。

**改动**：
- `src/extension/agent/workflow/dynamicGraphEngine.ts` `executeNode()`：将 `inputData` 序列化后拼入任务文本，形如：

```
${node.config.task}

## 上游节点数据
${JSON.stringify(inputData, null, 2)}
```

- 注入前做尺寸控制：单节点注入上限（建议 4,000 字符），超限截断并附 `[truncated]` 标记，防止上游长输出撑爆子代理上下文。
- 注入内容包裹在明确分隔的块中（参考 `projectMemory.ts` 的 `<project-memory-data trust="untrusted">` 做法），标注为数据而非指令，防注入。

**验收**：
- 新增测试：节点 B 声明 `inputMapping: { report: "nodeA.content" }`，断言 B 的子代理收到的 task 包含 A 的输出内容。
- 现有 `should track data flow between nodes` 测试保持通过。

### T2. custom 条件表达式接线（TODO(human) 已就位）

**问题**：[dynamicGraphEngine.ts:145](../../../src/extension/agent/workflow/dynamicGraphEngine.ts#L145) 恒返回 `true`。

**改动**：
- `evaluateCondition()` 中 `condition.type === "custom"` 分支：用 `dataFlowManager.evaluateExpression(condition.expression, ctx)` 求值，truthy 判定执行、falsy 判定 skip。
- 表达式缺失或求值抛错时的行为需定案（建议：按 skip 处理并发事件告警，绝不静默执行）。
- **此任务保留为人工实现**（现有 TODO(human) 标记），求值引擎已具备，仅需接线与边界策略。

**验收**：
- 新增测试：`condition: { type: "custom", expression: "nodeA.status" }` 等场景，覆盖 truthy/falsy/表达式无效三种分支。

---

## P1：可靠性

### T3. 失败传播与终态汇总

**问题**：依赖失败后下游永远 pending，主循环静默退出，`GraphCompleted` 不带错误。

**改动**：
- `execute()` 主循环：每波结束后扫描——依赖中存在 `failed` 且自身无 `onFailure` 条件的 pending 节点，标记为新增状态 `cancelled`（见 T8）或暂用 `skipped` + 原因字段。
- `GraphExecutionEvent` 增加 `GraphFailed` 或在 `GraphCompleted` 中附 `{ failedNodes, unreachedNodes }` 汇总。
- 有 `onFailure` 条件的下游节点仍应执行（失败处理路由是既有设计，不能被传播误杀）。

**验收**：
- 测试：A 失败 → B(依赖 A，无条件) 被标记不可达且事件可见；C(依赖 A，onFailure) 正常执行。

### T4. resolver 异常事件化

**问题**：resolver 抛错只 `console.error`，图继续跑，用户无感知。

**改动**：
- `resolveDependencies()` catch 中发出新事件 `{ type: "ResolverFailed", nodeId, error }`。
- 策略定案：resolver 失败视为该节点"扩展失败"但节点本身结果保留（不改写已 completed 状态）。

**验收**：测试断言 resolver 抛错时事件发出且已完成节点状态不变。

### T5. 初始节点支持 dependsOn

**问题**：`DynamicNodeConfig` 无 `dependsOn`，初始图只能平行。

**改动**：
- `dynamicGraphTypes.ts`：`DynamicNodeConfig` 增加 `dependsOn?: DynamicNodeId[]`。
- `execute()`：初始节点按声明依赖 `addNode(config, config.dependsOn ?? [])`；引用不存在的节点 ID 时抛错（fail fast）。
- `addNode` 增加环检测：初始集合内做拓扑校验（可抽取 `dagValidator.ts` 的思路复用，但引擎图与 orchestrator 图数据结构不同，允许独立实现小版本）。
- resolver 动态节点维持现状（仅依赖 resolver 节点），fan-in 放到 P3 评估。

**验收**：
- 测试：A → B → C 线性初始图按序执行；声明环 A→B→A 时构造期抛错；引用未知 ID 抛错。

---

## P2：调度与完整度

### T6. 波次屏障改连续调度

**问题**：`Promise.all(readyNodes.map(executeNode))` 按波推进，慢节点阻塞下一波；外加 100ms 轮询。

**改动**：
- 重构 `execute()`：每个节点完成时（`executeNode` 的 then）立即扫描其 dependents 是否就绪并启动，去掉波次 barrier 与轮询；用一个 in-flight 计数 + completion promise 判定图终止。
- 并发上限继续由底层 orchestrator 的 `maxConcurrentSubagents` 承担，引擎不重复限流。

**验收**：
- 测试：菱形图 A→(B慢,C快)→D 中，C 完成后其独立下游（若有）不等待 B；总完成事件仅在全部终态后发出。
- 基准：与现有波次实现对比同一图的 wall-clock（模拟 runner 加延时）。

### T7. globalData 写入口

**改动**：
- `DynamicGraphEngine` 增加 `setGlobalData(key, value)` / 定义级 `initialGlobalData`。
- 可选：节点配置增加 `exportTo?: string`，节点完成后把 `result.content` 写入 globalData 键，供 `$var` 引用。

**验收**：测试 `$var` 表达式解析出注入值。

### T8. 取消语义修正

**改动**：
- `NodeStatus` 增加 `"cancelled"`。
- `cancel()`：running/ready/pending 节点统一置 `cancelled`；退出时发 `GraphCancelled` 而非 `GraphCompleted`。

**验收**：现有 `should handle node cancellation` 测试更新断言；取消后无 `GraphCompleted`。

### T9. 节点重试策略（依赖 T3）

**改动**：
- `DynamicNodeConfig` 增加 `retry?: { maxAttempts: number; backoffMs?: number }`。
- 失败时按策略重建子代理重跑；重试耗尽才进入 T3 的失败传播。
- 上限保护：重试计入 `maxNodes` 预算，防止重试风暴。

**验收**：测试首跑失败、重试成功的节点最终 `completed` 且尝试次数可见。

---

## P3：进化能力衔接（对应 Hermes 差距分析的路径 A）

### T10. 反思循环模式（基于 resolver 的迭代展开）

**设计**：不引入真环——用 resolver 把"下一轮反思"展开为新节点链，`maxDepth` 天然成为最大反思轮数（比 LangGraph 的环 + recursion_limit 更易审计）。

**改动**：
- 提供内置 resolver 工厂 `createReflectionResolver({ maxRounds, judge })`：评审节点判定"不合格"时生成下一轮 `修正节点 → 评审节点` 对，判定合格或轮次耗尽时停止。
- 依赖 T1（评审意见需注入下一轮修正节点 prompt）与 T2（合格判定走 custom 条件）。
- 示例与文档：`docs/superpowers/` 下补一个反思循环用例。

**验收**：集成测试：模拟 runner 前两轮评审"不合格"、第三轮"合格"，断言图在第三轮收敛、总节点数符合预期。

### T11. 子代理经验入库（路径 A 落地）

**前置**：修订 [2026-07-24 规范](../specs/2026-07-24-subagent-workflow-execution-correction.md) 中"子代理不读取或写入项目记忆"的隔离条款——建议改为：**子代理仍不直接读写记忆；由 orchestrator 在 settle 时代为记录**（保持子代理无记忆工具权限，隔离原则不破）。

**改动**：
- `WorkflowOrchestrator.settle()`：`completed`/`failed` 时组装 `ReactAgentRunOutcome` 调用 `ProjectMemory.recordOutcome()`（注意 writer lease 归属主运行）。
- 主代理创建子代理前可通过既有 `loadContext()` 检索相关 lesson 并拼入 task（利用 T1 的注入通道）。

**验收**：集成测试：子代理成功 → `task_runs` 表新增记录；敏感内容过滤（`containsSensitiveContent`）路径覆盖。

---

## 统一验证清单（每阶段出口）

```bash
npm run type-check
npm test
git diff --check
```

- P0 出口另跑：`npm test -- dynamicGraphWorkflow`
- P3 出口另跑：`npm test -- projectMemory` 与新集成测试

## 风险与对策

| 风险 | 对策 |
|------|------|
| T1 注入上游数据引发 prompt 注入 | untrusted 数据块包裹 + 尺寸上限；沿用记忆系统的转义做法 |
| T6 重构引入调度竞态 | 保留波次实现为参照，用同一测试集做 A/B；连续调度灰度合入 |
| T9 重试放大 API 消耗 | 重试计入 maxNodes 预算；默认 maxAttempts=1（即不重试） |
| T11 触碰规范红线 | 先改规范文档并评审，再动代码；子代理工具面保持不变 |

## 不做的事（明确排除）

- 真环（回边）：用 T10 迭代展开替代，避免终止性证明负担
- 检查点持久化 / time-travel：价值确认前不投入（依赖场景验证）
- 动态节点任意 fan-in：等 T10 用例反馈后再评估
- 路径 B（SkillRegistry）与路径 C：本计划只覆盖到路径 A，后续另立计划
