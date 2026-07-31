# 动态工作流检查点与可恢复执行设计

## 目标

当动态工作流的一个节点失败时，系统只恢复失败节点及其受影响的后续节点，不重新执行已经成功的节点；VS Code 扩展重启后，仍能从同一工作流的最新检查点继续执行。

## 范围

本次覆盖：

- compiled semantic workflow 和 legacy 兼容入口的恢复契约；
- 节点成功、失败、取消、等待和副作用不确定状态的记录；
- 当前 parent run 内恢复，以及扩展重启后的恢复；
- 工作流检查点的 SQLite 持久化、版本校验和旧 run 防覆盖；
- `workflowStatus`、`resumeToken` 和完成门禁；
- legacy cycle 端点校验及同一节点重跑时的结果隔离；
- 单元、集成和 CDP 验收测试。

不在本次范围内：

- 分布式多宿主协调；
- 将工作流检查点写入 ProjectMemory；
- 任意 JavaScript 表达式、任意 fan-out 或新的工作流 DSL；
- 自动重复执行副作用不确定的编辑或命令。

## 核心决策

### 1. 独立的 workflow checkpoint 表

复用现有 `.loopagent/conversation.sqlite` 连接和 WAL 配置，但新增独立的 `workflow_checkpoint` 表，不复用 `interrupted_run`，避免 React 每步 checkpoint 覆盖图状态。

建议字段：

```text
conversation_id  TEXT PRIMARY KEY
run_id           TEXT NOT NULL
plan_hash        TEXT NOT NULL
revision         INTEGER NOT NULL
status           TEXT NOT NULL
checkpoint_json  TEXT NOT NULL
updated_at       INTEGER NOT NULL
```

写入必须匹配当前 `conversation_id + run_id`，并使用单调 `revision` 防止取消后的旧异步回调覆盖新运行。清理也必须带 `run_id` 条件。

### 2. 检查点是可恢复执行的唯一事实来源

检查点至少包含：

- `planHash`、`runId`、`revision`、工作流状态；
- frontier、已激活路由、执行次数和当前 step/version；
- 节点状态、输入指纹、结果、尝试次数、错误和副作用证据；
- state channel 的 JSON-safe 值；
- resolver/cycle 兼容状态和未解决错误。

`Map`、`Set`、`Date` 不直接序列化；恢复时校验版本、计划哈希和工作区标识。检查点内容限制大小，终态成功后删除可执行状态，仅保留必要诊断摘要。

### 3. 失败恢复而不是整图重跑

同一 `planHash` 且输入指纹未变化时：

- `completed` 节点复用结果，不创建新的 subagent；
- `failed` 节点按错误分类重试；
- 只有失败节点和受其输出影响的下游节点重新进入 frontier；
- 计划变化时生成新的 `planHash`，仅执行变化部分；
- 没有任何节点完成时，才允许从头执行。

`runDynamicGraph` 在部分失败时返回结构化失败结果和不透明 `resumeToken`。父智能体重发相同计划时，工具优先按 token/plan hash 读取检查点，不依赖模型重新描述所有历史状态。

### 4. 副作用安全边界

每次执行记录 `sideEffect: none | applied | unknown`：

- `none`：允许按错误分类重试；
- `applied`：仅在操作幂等或结果已验证时重试；
- `unknown`：进入 `recovery_required`，先对账、补偿或请求确认。

`applyEdit`、`runCommand` 等节点不能因为父智能体重新调用工具而盲目重复执行。工作区锁只负责串行化，不能代替操作幂等和对账。

### 5. 完成门禁

只有同时满足以下条件才返回 `workflowStatus: completed`：

- 所有必需节点已完成或明确跳过；
- `unresolvedFailures` 为空；
- 没有等待中的副作用对账；
- 检查点已原子提交。

失败、等待外部条件、等待用户输入和取消必须使用独立状态，不能被转换成普通成功或静默完成。

### 6. legacy 兼容边界

legacy `cycles.from/to` 在入口必须引用已声明节点；非法端点直接拒绝。legacy 循环每轮使用独立执行记录和结果快照，不能从全局 `completedNodes` 读取上一轮旧结果。新 semantic 路径不使用 `CycleManager`。

## 调用流程

```text
Webview resume / parent run
  -> providerRegistry 注入 conversationId/runId/checkpoint store
  -> runDynamicGraph
  -> 解析/编译并计算 planHash
  -> load checkpoint (同 run + 同 planHash)
  -> DynamicGraphEngine 恢复 frontier
  -> 节点执行与状态提交
  -> 原子保存 workflow_checkpoint
  -> 返回 completed / recovering / waiting / failed
```

扩展重启时沿用现有 interrupted run 恢复入口，并在 parent runner 恢复后自动加载同一 `runId` 的 workflow checkpoint。

## 验收标准

1. A 成功、B 失败，恢复后 A 的执行次数为 1，B 执行次数递增。
2. 扩展重启并重新打开同一会话后，A 不重复执行，B 从检查点继续。
3. 旧 run 的迟到写入不能覆盖新 run 的检查点。
4. 非法 cycle 端点、非法计划和超限图在执行前失败。
5. 副作用不确定时不会自动重复编辑或命令。
6. `npm test`、`npm run typecheck`、`npm run compile`、`git diff --check` 通过；同一 Extension Development Host 中的 CDP 恢复场景通过。
