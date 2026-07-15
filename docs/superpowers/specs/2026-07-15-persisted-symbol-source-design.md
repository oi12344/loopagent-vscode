# 持久化符号源码片段设计

> 状态：设计已批准，等待实施计划。
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

### 边界与回退

- 节点范围使用一基闭区间；`startLine < 1`、`startLine` 超过文件末尾或 `endLine < startLine` 均视为无效。有效范围的结束行裁剪到文件末尾。
- 每个 symbol source 最多 120 行，与现有 expanded-source 上限一致。
- 范围无效或截取结果为空时回退现有元数据 card，避免生成空 chunk。
- prompt 继续使用现有最多 6 个命中和 6,000 字符总预算，不新增配置。
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
6. 真实 SQLite FTS 查询和 VS Code prompt 返回函数正文，并继续遵守 6 条、6,000 字符和敏感路径限制。

## 非目标

- 不新增数据库 migration、列或表。
- 不实现 exact/RRF、图扩展或 embedding。
- 不保存完整文件源码。
- 不增加设置项、命令或新的抽象层。
