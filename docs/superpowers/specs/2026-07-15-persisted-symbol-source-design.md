# 持久化符号源码片段设计

> 状态：已实现。
>
> 前置功能：`docs/superpowers/specs/2026-07-14-sqlite-fts-context-minimal-design.md`

## 目标

让 SQLite FTS 命中的函数、方法和类向模型提供真实源码正文，而不再只提供名称、限定名、签名和调用摘要。正文变化必须更新持久化 chunk，使扩展重启后的代码上下文与已提交索引一致。

## 当前问题

`createCodeChunks` 目前把 symbol card 的 `sourceText` 设置为元数据摘要。SQLite FTS 可以定位符号，但 `renderPersistedCodeIntelligencePrompt` 只能渲染该摘要，模型无法检查函数内部状态、分支和调用参数。

`SnapshotInput` 已包含完整的 `parsed.text`，符号节点也已有一基行号 `startLine/endLine`。因此不需要新增数据库列、读取 RPC 或查询时文件 I/O。

## 方案

### Symbol card

`buildExtractionSnapshot` 把 `parsed.text` 传给 `createCodeChunks`。每个非 file 节点按 `startLine/endLine` 从该文本截取源码，最多保留 120 行，并写入现有 `CodeChunk.sourceText`。

`searchText` 保持现有名称、限定名、签名和调用 token，避免改变 FTS 命中规则。`embeddingText` 也保持现有元数据摘要，为后续 embedding 规格保留稳定输入。只有 `sourceText/sourceHash` 反映真实正文。

### File card

`file_card` 继续保存路径、语言、imports、symbols 和 diagnostics 摘要，不存整文件源码。这样避免重复存储整个文件，也不扩大文件级命中的 prompt 体积。

### 索引版本兼容

真实 symbol 正文改变了 chunk 持久化内容，因此 `workspaceIndexer` 的 `CHUNKER_VERSION` 提升为 2。已有 `chunker_ver=1` 的文件即使 mtime、字节数和正文 hash 均未变化，扩展重启时也会进入重新解析并覆盖旧元数据 card；完成后写回版本 2。

该机制复用现有 `files.chunker_ver` 字段和启动扫描流程，不新增 schema migration。

### 边界与回退

- 节点范围使用一基闭区间；`startLine < 1`、`startLine` 超过文件末尾或 `endLine < startLine` 均视为无效。有效范围的结束行裁剪到文件末尾。
- 每个 symbol source 最多 120 行，与现有 expanded-source 上限一致。
- 范围无效或截取结果为空时回退现有元数据 card，避免生成空 chunk。
- prompt 继续使用现有最多 6 个命中和 6,000 字符源码片段正文预算；该预算只累计命中 `sourceText` 经代码围栏转义后的正文，不代表最终完整 prompt 的字符数，也不新增配置。
- 敏感路径过滤、worker 串行读取和 SQLite 事务行为保持不变。

## 数据流

```text
parsed.text + node range
        -> createCodeChunks
        -> symbol sourceText/sourceHash
        -> existing SQLite chunks + FTS
        -> existing searchCodeChunks RPC
        -> existing persisted prompt renderer
```

## 取舍

采用“源码替换 symbol card 的 prompt 载荷”，而不是把摘要与正文拼接。FTS 所需元数据已在 `searchText`，拼接只会重复内容并浪费 prompt 预算。

不采用查询时读取工作区文件。该方式可能把新文件内容与旧数据库命中混合，且每次查询增加 Extension Host I/O。

## 验证

1. TypeScript 和 Python symbol chunk 的 `sourceText` 包含对应真实正文。
2. 只有函数体变化时，symbol chunk 的 `sourceHash` 变化，`searchHash` 保持不变。
3. 纯行号移动且正文不变时，`sourceHash` 保持不变，只更新范围。
4. 超过 120 行的符号只保存前 120 行。
5. 无效范围回退元数据 card。
6. 真实 SQLite FTS 查询和 VS Code prompt 返回函数正文，并继续遵守 6 条命中、6,000 字符源码片段正文载荷和敏感路径限制。
7. `chunker_ver=1` 的已索引文件在 mtime 和字节数不变时仍重新解析，并更新为版本 2。

## 非目标

- 不新增数据库 migration、列或表。
- 不实现 exact/RRF、图扩展或 embedding。
- 不保存完整文件源码。
- 不增加设置项、命令或新的抽象层。

## 实施结果

- `src/extension/intelligence/indexing/extractionSnapshot.ts` 将 `parsed.text` 传给 chunker。
- `src/extension/intelligence/languages/pythonAdapter.ts` 在无语法树 fallback 中按 dedent/EOF 关闭 class、function 和 method 范围，使持久化范围包含正文。
- `src/extension/intelligence/chunking/codeChunker.ts` 每个文件只分行一次，再按节点范围保存最多 120 行正文；无效或空范围回退元数据 card。
- `test/intelligence/pythonAdapter.test.ts` 覆盖 `tree: undefined` 时从 adapter 到 `buildExtractionSnapshot` 的函数、类和方法正文。
- `test/intelligence/codeChunker.test.ts` 覆盖 TypeScript、Python、hash 稳定性、120 行裁剪，并参数化验证起始行小于 1、结束行早于起始行和结束行超过 EOF。
- `test/intelligence/sqliteCodeSearch.test.ts` 验证真实 SQLite FTS 查询返回持久化函数正文。
- `src/extension/intelligence/indexing/workspaceIndexer.ts` 使用 chunker 版本 2 触发旧索引重建。
- `test/intelligence/workspaceIndexer.test.ts` 使用真实 SQLite store 写入 hash 匹配的旧 `source_text/source_hash`，验证文件元数据不变时重建并替换存储值与搜索返回值。
- `src/extension/intelligence/context/codeIntelligencePrompt.ts` 在代码围栏转义后执行 6,000 字符正文截断，避免转义扩长突破载荷预算。
- 全量测试、类型检查、编译和 `git diff --check` 均通过；schema 和 worker RPC 未改动。
