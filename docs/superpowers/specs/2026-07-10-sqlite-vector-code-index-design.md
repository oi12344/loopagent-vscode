# SQLite 持久化与向量代码索引总览

> 状态：总体设计和六份子规格已批准；存储与 worker 子计划执行中。
>
> 本文只维护跨子系统目标、全局约束、依赖顺序和最终验收。字段、算法和局部失败处理以对应子规格为准。

## 目标

将当前常驻内存的工作区代码索引迁移到 LoopAgent 自有 SQLite 数据库，实现：

1. 扩展重启后复用未变化文件的索引。
2. 以稳定符号 chunk 为单位更新源码、FTS、关系和 embedding。
3. 通过 exact token、FTS、SQL 图扩展和可选向量召回生成有界模型上下文。
4. 不在 Extension Host 中长期保留完整仓库源码、抽取结果、语义图或 token 索引。

## 背景与取舍

现有实现已经具备 Tree-sitter AST 抽取、按文件 hash 复用结果、内存语义图、轻量搜索索引和上下文预算，但扩展重启后状态丢失，每次请求仍需重组仓库级内存结构。明确标识符查询能够命中源码，中文抽象问题则容易因为缺少代码 token 而召回失败。

本设计参考 CodeGraph 的 `files + content_hash + nodes + edges + unresolved refs + FTS + WAL` 存储思路，但维护 LoopAgent 自有 schema。SQLite 解决持久化和有界 SQL 查询，Tree-sitter 继续提供结构事实，向量只补充语义候选。这样避免本地业务词表、完整内存双写和 native addon 打包成本。

## 非目标

1. 不读写 `.codegraph/codegraph.db`，也不依赖 CodeGraph CLI。
2. 不实现 `Tree.edit()` 或字符级增量解析；变化文件仍做完整 Tree-sitter 解析。
3. 不引入本地业务词表或 LLM 查询意图识别。
4. 第一版不加载 native vector 扩展，也不向量化整文件源码。
5. 不把 parser、grammar、临时 AST、SQLite 连接或单次查询候选持久化。

## 全局决策

1. 最低 VS Code 版本为 `^1.103.0`，extension bundle target 为 Node 22，数据库使用内置 `node:sqlite`。
2. SQLite 是唯一持久化索引事实源；Extension Host 通过独立 `worker_threads` worker 访问数据库。
3. 文件变化后完整解析当前文件，但数据库、FTS 和 embedding 只更新发生变化的稳定 chunk。
4. 敏感路径在扫描或 watcher 入队前过滤，并在读取文件前再次过滤；第二次检查是不可绕过的安全边界。
5. exact token、FTS 和 SQL 图扩展先形成不依赖 embedding 的可用链路；向量通过可选接口后续注入。
6. writer 租约覆盖获取、续租、丢失后只读降级、定期重试和释放；任何写事务都验证有效租约。
7. 所有查询和写入都有明确预算，不提供读取完整数据库图或全部向量的生产接口。
8. `contextBudget.ts` 继续控制最终发给模型的源码规模。

运行时基线由真实宿主能力决定，而不是只按 `node:sqlite` API 是否存在判断。Windows x64 相邻稳定版实测结果为：VS Code `1.102.0` 的 Node `v22.15.1` / SQLite `3.49.1` 不含 `ENABLE_FTS5`，实际创建 FTS5 虚表失败；VS Code `1.103.0` 的 Node `v22.17.0` / SQLite `3.50.0` 同时通过 SQLite、WAL、foreign key 和 FTS5 探针。因此 `1.103.0` 是本设计使用内置 FTS5 的最低宿主门禁。

## 总体数据流

```text
VS Code scan / watcher
  -> 持久化 index_jobs
  -> 读取变化文件并完整解析 AST
  -> 生成稳定 ExtractionSnapshot
  -> SQLite worker 事务应用 snapshot diff
  -> exact / FTS / optional vector 候选
  -> 有界 SQL 图扩展
  -> contextBudget
  -> 模型 prompt
```

数据库位于 `ExtensionContext.storageUri`。仓库、Settings Sync 和普通日志都不得包含数据库、源码 chunk、embedding 或密钥。

## 子规格

| 顺序 | 子系统 | 权威规格 | 主要输出 |
| --- | --- | --- | --- |
| 1 | 存储与 worker | [SQLite 存储与 worker 设计](2026-07-11-sqlite-index-storage-worker-design.md) | schema、migration、RPC、job、writer lease |
| 2 | chunk 与 snapshot | [稳定 chunk 与 snapshot 差异设计](2026-07-11-sqlite-index-chunk-snapshot-design.md) | 稳定身份、chunk、三层 hash、事务差异 |
| 3 | workspace 增量 | [工作区增量索引设计](2026-07-11-sqlite-index-workspace-incremental-design.md) | 扫描、路径策略、watcher、依赖重解析 |
| 4 | 检索与上下文 | [SQLite 检索与模型上下文设计](2026-07-11-sqlite-index-retrieval-context-design.md) | exact、FTS、SQL graph、基础 HybridRetriever |
| 5 | embedding 与向量 | [Embedding 与向量召回设计](2026-07-11-sqlite-index-embedding-vector-design.md) | provider、内容缓存、向量扫描和融合 |
| 6 | 生命周期与验证 | [扩展生命周期与端到端验证设计](2026-07-11-sqlite-index-lifecycle-validation-design.md) | 命令、清理、宿主/VSIX/真实模型验证 |

## 依赖与阶段门禁

子系统按表中顺序实施。每一阶段只有在以下条件同时满足后才能进入下一阶段：

1. 对应规格的验收测试通过。
2. `npm run typecheck` 和受影响测试通过。
3. 相关文档已同步当前实现，没有隐藏决策或未登记技术债。
4. `git diff --check` 通过并形成独立提交。

检索阶段必须在没有 embedding provider 时完整可用；embedding 阶段只能通过既有可选接口增强排序。生命周期阶段负责跨阶段的真实宿主验证，但不得替代各子系统自己的单元和集成测试。

## 最终验收

1. VS Code `1.103.x` 和当前版本都能加载 `node:sqlite`、FTS5、WAL 和数据库 worker。
2. 重启后未变化文件不重新运行 parser 或 chunker。
3. 单函数变化只影响对应 chunk、出边、FTS 和 embedding 状态；纯行号移动不更新 FTS 或 embedding。
4. 新增、删除、重命名后不存在旧 chunk、孤立边、错误 FTS hit 或失效 embedding 映射。
5. 事务失败后查询仍读取完整旧版本，重启后持久化 job 可以恢复。
6. 未配置 embedding provider 时 exact token、FTS 和 graph 可独立工作。
7. 两个实例共享同一数据库时任一时刻最多一个 writer；租约丢失实例保持只读查询能力。
8. 被排除的敏感文件不会被读取，也不会出现在任何 SQLite 表中。
9. Extension Host 不保留完整仓库 source、extraction、graph 或 search Map。
10. rebuild、clear、status、最低宿主、当前宿主、VSIX 和真实模型验证全部通过。

## 实施导航

总实施顺序和阶段状态记录在 `docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-plan.md`。每份子规格对应一份同名日期前缀的子计划；总计划不再重复实现细节。
