# SQLite FTS 上下文最小设计

> 状态：最小闭环已实现；后续可按上位规格增加图扩展与混合检索。
>
> 上位规格：`docs/superpowers/specs/2026-07-11-sqlite-index-retrieval-context-design.md`

## 目标

让已完成的工作区 SQLite 索引直接为模型代码上下文提供有界 FTS5 结果；索引未就绪、没有命中或查询失败时，保持现有内存索引结果不变。

## 范围

- 在 `SqliteIndexStore` 增加最多返回指定数量 chunk 的只读 FTS5 查询。
- 通过既有 worker RPC 暴露固定 DTO，不暴露 SQL。
- VS Code 工作区智能模块优先渲染 SQLite 命中，继续保留内存回退。
- 查询复用 `createSearchTokens`，只由受控 token 生成 FTS 表达式。

## 非目标

- 不迁移完整内存图、源文件缓存或既有 prompt 契约。
- 不实现 exact token 独立排序、图扩展、RRF、pending-job 等待或 embedding。
- 不增加设置、命令、依赖或新的 worker。

## 数据流

模型任务 -> VS Code 工作区智能 -> SQLite worker FTS5 -> 最多 6 个 chunk -> 代码上下文 prompt

当 SQLite 无结果或失败时，回退到现有内存索引 prompt。

FTS 查询仅选择 `files.path`、chunk 行范围和 `source_text`，按 BM25 后再按 chunk ID 稳定排序。空 token 返回空数组，不执行 `MATCH`；`limit` 必须为正整数。渲染不输出数据库路径或受排除文件。

## 验证

1. 真实 SQLite snapshot 可以按标识符返回源码 chunk，且返回量不超过 limit。
2. 含 FTS 操作符的输入不改变查询结构；空输入不命中。
3. 启用持久化索引的 VS Code 实例优先输出 SQLite chunk；无结果时保留内存结果。

## 完成记录

2026-07-14：已实现有界 FTS5 worker RPC 和 VS Code prompt 接线。查询限制为 1-6 条，读取时再次执行工作区敏感路径策略，片段正文限制为 6,000 字符；首个 prompt 不等待初始索引 drain，SQLite 未命中或查询失败时回退内存索引。验证：`npm test -- --reporter=dot` 通过 50 个测试文件、263 个用例；`npm run typecheck`、`npm run compile` 与 `git diff --check` 通过。
