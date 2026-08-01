# 动态工作流失败诊断与结果恢复设计

## 目标

失败节点不再原样盲目重试。系统先保存可审计的失败证据，分析失败原因并生成受约束的修复动作；修复执行产出满足节点结果契约后，才把结果写回原节点并释放下游节点。已经成功的上游节点始终复用，不重新执行。

## 当前问题

- `dynamicGraphEngine.executeNode` 对失败任务重复提交相同的 `task`，没有把失败日志、上游输入和工具调用证据交给诊断阶段。
- `workflowRecovery.ts` 已有错误分类和恢复计划校验，但没有运行时 supervisor 接管失败节点。
- `workflowOrchestrator` 保留子代理消息，但 `SubagentResult` 只返回状态、内容和错误，恢复流程无法读取结构化日志。
- 节点仅按 `status` 判定完成；上一次 CDP 已证明节点可以标记 `completed`，但输出内容没有满足任务要求，导致下游拿不到可用数据。
- 失败节点恢复后仍会保留 `failed` 终态，补偿节点成功也不能让原工作流获得合法完成状态。

## 设计

### 1. 失败证据

每次节点最终失败生成 `WorkflowFailureEvidence`，只保存 JSON-safe、脱敏后的诊断数据：

- `nodeId`、原始任务、角色、输入数据和上游节点结果摘要；
- 每次尝试的序号、状态、错误原文、超时配置和工具调用数量；
- 子代理消息中可用于诊断的 assistant/tool/error 摘要；
- `sideEffect`、`planHash` 和 checkpoint revision。

凭据、完整工具参数中的 secret 和二进制内容不进入证据。证据写入 checkpoint 的 `unresolvedFailures`，并通过工具结果返回诊断摘要。

### 2. 诊断与修复状态机

节点状态按以下顺序推进：

```text
running -> failed -> diagnosing -> repairing -> validating -> completed
                         |             |            |
                         +-------------+------------+-> recovery_required
```

- `failed` 后先调用只读诊断器，不再次执行原任务。
- 诊断器接收失败证据和已完成上游结果，只能返回 `RecoveryPlan`；现有 `parseRecoveryPlan` 负责动作、节点身份、角色和预算校验。
- 对模型常见的 `retry + task` 组合，仅在 task 非空时先归一化为 `replace_node` 再严格校验；这表示模型已经给出替换任务但动作标签选错，不放宽其他非法字段或副作用边界。
- `retry` 仅允许确定的瞬时错误，并且必须使用新的诊断上下文；`replan`/`replace_node` 允许改变任务或输入；副作用为 `applied/unknown` 时只能对账、补偿或请求人工。
- 每个失败节点的诊断/修复预算独立计算，达到上限后进入 `recovery_required`，不再自动调用同一动作。
- 诊断器生成可执行恢复计划后，先把 `pendingRecovery` 写入 checkpoint，再执行修复任务。进程在修复期间退出时，恢复运行直接执行该计划，不重新提交原失败任务，也不再次消耗诊断预算。

### 3. 原节点结果恢复

修复动作默认仍作用于原 `nodeId`，不复制已完成上游节点。修复成功后：

1. 用原节点的 `inputMapping` 和上游结果重建输入；
2. 使用修复后的任务执行一次受约束的子代理；
3. 校验输出契约；
4. 以新的结果覆盖原失败结果，状态改为 `completed`，更新 `exportTo`/data flow；
5. 重新调度依赖该节点的下游。

修复失败时保留所有失败证据，原节点仍为 `recovery_required`，下游不得读取失败结果冒充成功数据。

### 4. 输出契约

节点增加最小 `outputContract`，支持：

- `exactText`: 去除首尾空白后必须与固定文本完全一致，不能用“未找到 EXPECTED”这类包含标记的否定文本蒙混通过；
- `requiredText`: 输出必须包含的固定标记；
- `requiredFields`: 当输出是 JSON 时必须存在的字段；
- `minLength`: 非空文本的最小长度。

未配置契约时保持当前兼容行为；配置后，内容不满足契约视为 `contract` 失败并进入诊断，而不是直接标记 `completed`。

### 5. 接口边界

- `WorkflowOrchestrator.waitForSubagents` 仍返回 `SubagentResult`，新增只读 `diagnosticLog` 字段；编排器负责从消息流生成摘要并限制大小。
- `DynamicGraphEngine` 增加恢复回调，负责节点状态、输入复用、结果校验和下游调度；诊断器由 `dynamicWorkflowTools` 注入，避免引擎直接依赖模型供应商。
- `runDynamicGraph` 返回 `workflowStatus`、`failedNodes`、`recoveryDiagnostics`、`resumeToken` 和输出契约错误；成功恢复后清除该节点的未解决失败记录。
- checkpoint 保存动态扩展节点定义和恢复诊断历史，并对任务、输入、结果、错误和日志统一做脱敏与长度限制；保存失败只作为可见的 `checkpointError`，不能打断节点恢复。
- `resumeToken` 在提供时必须匹配对话、运行、计划和 revision。同一对话开始新 run 时通过原子 claim 接管旧 run 的 checkpoint；完成或清除 checkpoint 后保留终态 owner 栅栏，存储层继续拒绝旧 run 的迟到写入和低 revision 写入。

## 不在本次范围

- 不改变副作用节点的安全边界，不自动重做 `applyEdit`/`runCommand`。
- 不引入通用 JSON Schema 依赖；输出契约只实现上述四个最小规则。
- 不重跑成功上游，也不把整个图退回从头执行。

## 验收标准

1. 节点 A 成功、节点 B 失败时，诊断器能看到 B 的错误、输入、上游 A 结果和尝试日志。
2. 修复 B 成功后，A 的执行次数仍为 1，B 的合法结果可被 C 消费，最终状态为 `completed`。
3. 输出契约不满足时，B 不得进入 `completed`，并留下 `contract` 诊断记录。
4. 相同诊断动作达到预算后进入 `recovery_required`，不会无限重试。
5. `sideEffect: unknown/applied` 不会自动执行修复任务。
6. 真实 CDP 场景能观察到失败原因、诊断动作、修复结果和下游收到的有效数据。
