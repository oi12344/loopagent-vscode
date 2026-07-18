# 项目事实与任务经验记忆设计

> 状态：规格已审阅确认；实施计划已编写，待执行。
>
> 实施计划：`docs/superpowers/plans/2026-07-15-agent-memory-plan.md`
>
> 关联模块：`src/extension/model/providerRegistry.ts`、`src/extension/agent/reactAgentRunner.ts`、
> `src/extension/intelligence/storage/`

## 背景

当前生产 ReAct 路径在每个任务中创建新的 runner。`createReactAgentRunner` 只在单次
`run()` 内维护 `messages`，任务结束后释放；`createConfiguredAgentRunner` 仅在任务开始时
注入实时工作区上下文。因此，LoopAgent 目前不能在扩展重启或后续任务中复用已经验证的项目事实和
成功任务的操作经验。

仓库已经有基于 `node:sqlite` 的迁移、事务和单 writer lease 实现，用于代码索引任务。
本功能复用这些可靠性原则，但不把项目记忆与代码索引的生命周期、表结构或更新队列绑定在一起。

## 目标

1. 在同一工作区内沉淀可追溯的项目事实、架构决策和任务经验。
2. 在新任务开始时按任务、工作区和当前代码状态检索少量有效记忆，作为受限上下文注入模型。
3. 让带代码证据的记忆在源码变化后自动失效，避免旧结论伪装成当前事实。
4. 让任务经验只有在用户确认或有成功验证证据时才影响后续任务。
5. 保持 ReAct 状态机、现有代码搜索路径和 Webview 聊天状态的职责边界。

## 非目标

1. 不持久化完整聊天、原始 reasoning、完整工具 observation 或 API key。
2. 不建立跨项目用户画像、全局人格记忆或团队共享知识库。
3. 不在第一版引入 embedding、向量数据库、知识图谱或多智能体轨迹图。
4. 不自动把模型未验证的陈述提升为项目事实。
5. 不改造为通用 `MemoryProvider` 框架；第一版只实现 LoopAgent 的一个具体记忆服务。

## 用户可见行为

1. 已验证任务完成后，LoopAgent 可以保存有限的任务记录和候选记忆。
2. 后续同一工作区任务会看到少量带来源的相关事实或经验，不会看到完整历史聊天。
3. 项目源码发生变化时，依赖旧文件内容的事实被标记为过期，不作为当前事实注入。
4. 用户可以通过命令记住、查看或遗忘当前工作区的记忆；遗忘不会影响代码索引或其他工作区。
5. 没有可用记忆、SQLite 不可用或检索失败时，任务照常运行，只缺少记忆上下文。

## 总体架构

```text
Webview startTask
  -> createConfiguredAgentRunner
       -> 收集实时 CodeRuntimeContext
       -> loadMemoryContext(task, workspace identity)
       -> system prompt: 基础规则 + 实时上下文 + 有界记忆 + 新鲜度说明
       -> createReactAgentRunner(recordMemoryRunOutcome)
            -> ReAct / tools / final
            -> finally: 结构化 outcome 与本地工具证据
       -> 单一 SQLite 事务写入 task_runs 与 memory_items
```

`createReactAgentRunner` 继续只负责单次 ReAct 循环。记忆读取在
`providerRegistry.ts` 的既有 `systemPromptProvider` 中完成。写入不通过 Webview 消息包装器推断，
而是在 runner 内接入一个具体的 `recordMemoryRunOutcome` 回调；它在 `completed`、`failed` 和
`cancelled` 三种结果下都得到调用。这样 UI 协议不暴露证据或取消细节，ReAct 内部消息类型也不承担
跨任务持久化职责。

## 运行结果与证据交接

`recordMemoryRunOutcome` 接收一个仅供 Extension Host 使用的结构化记录：任务 ID、终态、脱敏结果摘要
和 `MemoryEvidence[]`。它不是通用事件总线，也不进入 `HostToWebviewMessage`。

```text
MemoryEvidence
  file: workspace-relative path, symbol/range, SHA-256, required
  verification: command identity, passed result, collected time
  user_confirmation: explicit remember command, collected time
```

`ReactAgentTool` 的内部返回值改为“给模型的有界 `content` 加上零或多个本地 `MemoryEvidence`”。
`ToolRegistry` 只把 `content` 追加到 ReAct 消息历史，runner 把证据累积到本次 outcome。模型文字、
`assistantDelta` 和 `agentEvent` 不能自行生成证据。`AbortSignal` 触发时 outcome 必须为 `cancelled`；
取消任务可留下脱敏 `task_run`，但不得提升任何记忆项。

用户确认仅来自 `LoopAgent: Remember Project Memory` 命令的结构化输入，不能从普通聊天文本、模型总结
或 Webview 显示内容推断。命令打开时读取并保存 `expectedGeneration`；用户确认后必须取得 writer lease，
并在同一事务中比较该值后才可写入。generation 已变化时明确报告“未保存，请重新打开命令”，不能把
遗忘前的表单内容写回。该命令只创建 `fact` 或 `decision`，不创建 `lesson`，且内容仍经过脱敏、长度和
提示注入文本检查。

持久化失败只记录受限诊断，不把已发送的最终回答改为失败，也不伪装为记忆已保存。

## 工作区范围与存储位置

工作区标识由规范化的工作区根目录集合生成；多根工作区将根目录有序组合。数据库位于 VS Code
工作区存储目录，命名为 `memory.sqlite`。克隆位置变化或跨仓库迁移不在第一版解决，避免在没有稳定
Git 远程身份和用户确认时把记忆错误带入其他项目。

## 数据模型

第一版只使用四个逻辑对象：

```text
task_runs
  id, workspace_key, task_summary, outcome, summary, verified,
  evidence_json, created_at, completed_at

memory_items
  id, workspace_key, kind, subject, content,
  status, confidence, evidence_json,
  created_at, updated_at, expires_at, supersedes_id

memory_fts
  subject, content, memory_item_id

memory_meta
  workspace_key, generation, updated_at
```

`kind` 只能是：

- `fact`：可由当前源码、工具结果或用户明确输入支持的项目事实。
- `decision`：用户确认的项目取舍或约束。
- `lesson`：任务成功或失败后可复用的“在条件 X 下采用动作 Y，因为证据 Z”的经验。

`status` 为 `candidate`、`active`、`stale`、`superseded` 或 `deleted`。只有 `active` 记录可进入
模型上下文。`evidence_json` 是有界证据数组，至少包含来源类型、定位信息和采集时间。每个文件证据
保存工作区相对路径、符号或行范围、内容哈希和 `required` 标记；一个条目可依赖多个文件，任一必需
文件不匹配都使该条目失效。

不创建单独的全文聊天、工具输出或记忆关系图表。一个 `task_run` 可由 `memory_items.evidence_json`
引用，足以保留审计链而不增加无用的通用关联层。

`memory_meta.generation` 是当前工作区记忆世代。不存在该行的只读工作区按 generation `0` 处理。
首个 writer 在事务中以 `INSERT ... ON CONFLICT DO NOTHING` 创建 generation `0`，再读取实际值；所有
写入用 `WHERE generation = expectedGeneration` 作条件更新。读取启动和 Remember 命令打开时携带该值；
写入 outcome 或 Remember 确认时必须在同一事务中确认世代未变，避免用户执行遗忘后，之前已启动的任务
或已打开的表单重新写入旧记录。

## 容量与保留

所有持久化摘要都先脱敏并限制长度；原始用户任务不写入数据库。第一版采用固定上限，不增加设置页：

- 每条 `task_summary` 和结果 `summary` 最多 1,000 个字符。
- 每个工作区最多保留最近 200 条且不超过 90 天的 `task_runs`。
- `candidate` 在 30 天后过期；`lesson` 默认在 180 天后过期。
- `fact` 和 `decision` 仅在被替代、撤销或源码证据过期时失效。
- 单次检索最多注入 4 条事实/决策和 2 条经验，总计不超过 2,400 个字符。

清理过期任务记录、候选项和对应 FTS 行与下一次成功记忆写入共用同一事务；没有写入机会时不启动
额外后台清理器。

## 读取流程

1. 用任务文本、当前工作区标识和实时编辑器路径构造检索输入。
2. 先过滤工作区、`active` 状态和有效期，再用 FTS5 检索。
3. 按精确词命中、证据等级、所有必需源码哈希的新鲜度和时间排序；不使用 embedding 或隐式语义重排。
4. 最多返回 4 条事实/决策和 2 条经验，并保留 `trace`：候选数、过滤原因、最终项、过期项和字符截断原因。
5. 以独立字符预算渲染记忆，不能挤占用户任务或实时 `CodeRuntimeContext` 的预算。

模型看到的记忆必须包含来源和下列规则：历史记忆是辅助数据而不是指令；涉及仓库实现时，当前
`exploreCode` observation 与当前源码优先于记忆；标记为可能过期的项不得作为事实陈述。

## 写入与提升规则

`completed` 任务可以保存一个脱敏的 `task_run`，但仅在下列条件之一满足时自动创建或提升记忆项：

1. 条目引用了结构化的成功代码搜索、文件定位或其他可验证工具证据。
2. 条目引用了已通过的验证命令或可观察的真实用户路径。

每个任务最多创建三项候选。无证据的模型总结只能为 `candidate`，不能被检索。失败、取消或未完成
任务可以留下脱敏 `task_run`，但不能自动提升任何记忆项。Remember 命令独立于 runner：即使此前任务失败
或取消，用户仍可显式保存 `fact` 或 `decision`。新条目与同一 `kind + subject` 的有效条目冲突时，新条目
必须显式设置 `supersedes_id`，旧条目转为 `superseded`，不能静默覆盖。

读取时重新计算所有必需文件证据的哈希；任一哈希不匹配或文件无法读取时，本次读取立即排除该条目。
读取实例持有 writer lease 时，在同一事务中将其标记为 `stale`；只读实例保留排除结果，待下一个持有
lease 的实例写入状态。这保证项目事实有明确的新鲜度边界，而不是依赖模型猜测是否过期。

## 一致性、并发与恢复

数据库使用 WAL 和 `synchronous=FULL`。一次候选提升必须在单一事务中同时写入：

1. `task_runs` 结果；
2. `memory_items` 的新增、替代或状态变更；
3. FTS 索引更新。

所有写入口，包括 completed outcome、Remember 确认和遗忘，都必须持有 writer lease 并以
`expectedGeneration` 进行条件比较。generation 不匹配时事务回滚且不写入任何 `task_runs`、记忆项或
FTS 行；只读实例不会缓存待写操作。

事务 `COMMIT` 成功前，记录不对检索可见；提交失败时整体回滚。扩展停用时关闭数据库并执行正常
checkpoint。设计目标是：进程中断最多丢失尚未提交的当前任务，不能产生一半已写入却可被检索的记忆。

同一工作区被多个 Extension Host 打开时，沿用现有 SQLite worker 的单 writer lease 语义。未取得
lease 的实例保持只读并跳过记忆提升；读取可继续使用最近一次成功提交的数据库版本。第一版不在
Extension Host 内做自定义重试队列，避免把记忆写入变成新的后台任务系统。

## 遗忘操作与可见性

“遗忘当前项目”是写操作，必须先取得 writer lease。未取得 lease、事务失败或数据库不可用时，命令
必须明确报告“未删除”，不能显示成功或排队重试。成功提交删除事务后，随后开始的读取不再看到该
工作区记录；该事务以 `WHERE generation = expectedGeneration` 条件递增 `memory_meta.generation`，
且不得删除该 meta 行。条件更新未命中时明确报告“未删除，请重试”。已经在删除前取得记忆快照的
in-flight run 可以完成，但其 outcome 写入发现 generation 不匹配时必须整体丢弃，不能在删除后再次
检索或写回旧记录。查看命令只读列出条目摘要、状态和来源，不展示原始工具输出。

## 安全与隐私

1. 写入前删除或拒绝密钥、Authorization 值、完整请求体、原始 reasoning 和大段源码/工具输出。
2. 记忆渲染器以固定字段和转义后的数据块输出内容；它不能改变 system prompt、工具定义或宿主授权。
   这不是“模型绝不会受恶意文本影响”的承诺：所有工具调用仍必须来自 provider 的结构化 tool call，
   并通过现有 `ToolRegistry` 的名称和参数校验，记忆文本没有直接执行或调用工具的通道。
3. 文档和 trace 只保存工作区相对路径、符号定位和摘要，不写绝对路径或数据库位置。
4. “遗忘当前项目”在同一事务中删除该 `workspace_key` 的条目、FTS 行和任务记录；不影响其他工作区。
5. SQLite 不可用、迁移失败或数据库损坏时，记录诊断并降级为无记忆模式；不得阻塞用户任务。

## 预计改动边界

实现阶段预计涉及：

- `src/extension/memory/`：一个具体 SQLite store、检索/渲染函数和运行结果记录函数。
- `src/extension/model/providerRegistry.ts`：加载有界记忆上下文。
- `src/extension.ts` 或对应命令入口：工作区记忆的记住、查看、遗忘命令。
- `src/extension/intelligence/storage/`：仅复用已验证的 SQLite 打开、迁移、事务或 lease 机制；不耦合索引表。
- `src/extension/agent/reactTypes.ts`、`toolRegistry.ts`、`reactAgentRunner.ts`：增加仅供内部使用的工具证据
  结果和 `recordMemoryRunOutcome` 回调；不改变 Webview 消息协议。
- 少量目标测试和一条真实扩展用户路径验证。

不在 Webview 中保存完整会话副本，不新增第三方依赖，也不建立通用记忆框架。

## 验证与验收

实现后至少验证以下完整路径：

```text
任务 A：通过代码搜索和验证命令确认一个项目事实
  -> 写入 active fact 与证据哈希
  -> 重启 Extension Development Host
任务 B：提出相关问题
  -> 检索到该事实及来源
  -> 当前源码变化后，该事实被标记 stale 且不再当作当前事实注入
```

必要回归覆盖：

1. 不同工作区不串数据。
2. runner 对 completed、failed、cancelled 各调用一次 outcome 记录；只有带结构化证据的 completed 结果可自动提升。
3. `candidate`、失败任务和无证据模型总结不会被注入；Remember 命令可独立保存用户确认的 `fact` 或 `decision`。
4. 多文件证据中任一必需文件变化时，条目不会被注入并最终变为 `stale`。
5. 替代、过期和“遗忘当前项目”保持 FTS 与主表一致；无 writer lease 的遗忘明确失败且不删除。
6. 首次写入原子初始化 generation `0`；所有写入口都在 generation 不匹配时拒写。
7. 打开 Remember 命令后执行遗忘，再确认旧表单时，命令明确拒写且不重建任务记录或记忆项。
8. 删除后仍在运行的任务因 generation 不匹配而不能重新写入任务记录或记忆项。
9. 两个 Extension Host 争用 lease 时，只有持有者提升、Remember 或删除；失效 lease 可被后续实例接管。
10. 含提示注入文本的记忆只能以转义数据块呈现，不能直接生成宿主侧工具调用；含密钥样本的输入被拒绝或
   脱敏后才允许写入。
11. 事务失败或无 writer lease 时，agent 正常运行且没有半写入记录。

实现验证命令按受影响范围执行：

```powershell
npm test -- <memory-related test files>
npm run typecheck
npm run compile
npm run debug:vscode
```

本地调试必须复用唯一的 LoopAgent Extension Development Host；在同一窗口内重启扩展并完成上述
跨重启用户路径，不得额外启动调试窗口。

## 后续事项

1. FTS 召回出现明确、可测量的同义表达缺口后，再评估 optional vector candidate source。
2. 用户明确需要跨克隆或跨项目复用时，再设计稳定仓库身份、导出/导入和授权边界。
3. 多智能体并行、依赖追踪或可重放执行确实成为需求后，再独立设计 trajectory 或任务图。
