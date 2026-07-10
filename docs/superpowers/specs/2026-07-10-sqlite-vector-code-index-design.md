# SQLite 持久化与向量代码索引设计

> 状态：设计已批准，实施计划已编写，等待执行。
>
> 本版本取代本文档早期的“文件变化后删除并重建全部文件索引”和“暂时保留完整内存图”方案。新的更新粒度是符号 chunk，SQLite 是唯一持久化索引事实源。

## 已确认决策

1. 参考 CodeGraph 的 `files + content_hash + nodes + edges + unresolved_refs + FTS + WAL` 模型，但不读写 `.codegraph/codegraph.db`，由 LoopAgent 独立维护数据库。
2. 最低 VS Code 版本从 `^1.96.0` 提升到 `^1.101.0`，构建目标从 Node 20 提升到 Node 22，使用内置 `node:sqlite`。
3. SQLite 运行在独立 `worker_threads` worker 中，Extension Host 不直接执行同步数据库调用。
4. 文件变化后仍使用 Tree-sitter 完整解析该文件，但只更新发生变化的符号 chunk、关系、FTS 和 embedding；本阶段不实现 `Tree.edit()`。
5. 可恢复、跨请求有价值的索引状态全部落 SQLite；parser、grammar、临时 AST 和单次查询结果保留在内存。
6. 不保留并行的完整 `sourceCache`、`extractionCacheByFile`、`SemanticGraph` 或 `SearchIndex` 作为正常索引路径。

## 背景

当前代码智能索引已经具备按文件内容 hash 复用抽取结果、Tree-sitter AST 抽取、内存语义图、轻量搜索索引和上下文预算层。真实 DeepSeek 测试证明，明确包含代码标识符的问题可以命中相关源码；但扩展重启后索引丢失，每次请求仍重组完整内存图，文件变化时也只能整文件替换抽取结果。纯自然语言问题，例如“模型集成是怎么实现的”，因为没有 `providerRegistry`、`modelRunner` 等代码 token，当前词法索引还可能无法召回代码上下文。

不采用本地业务词表作为长期方案。本地词表虽然可以快速修复“模型集成”这类单点问题，但会把项目知识硬编码到规则里，后续每新增一个业务域都要人工维护，容易变成不可控的别名库。

本设计目标是引入 SQLite 持久化索引、FTS 和可插拔向量召回，用自动生成的结构化代码 chunk 替代人工业务词表，让中文、英文、模糊自然语言问题都能先召回真实代码入口，再通过语义图扩展和预算层生成最终上下文。

## 目标

1. 使用 SQLite 持久化 `files`、`nodes`、`edges`、`chunks`、FTS、embedding、诊断和更新队列，扩展重启后直接复用未变化索引。
2. 使用 AST 符号优先切块，生成适合检索的 `file_card`、`symbol_card`、`class_card`、`callsite_card`、`test_case_card` 和 `source_body`。
3. 使用稳定 chunk ID 与内容 hash 做差异更新，使未变化 chunk 的 FTS 和 embedding 保持不变。
4. 使用 FTS 处理精确标识符、路径、签名和关键字检索。
5. 使用可插拔向量召回处理中文和抽象自然语言查询，向量只负责找候选入口，不直接决定最终回答事实。
6. 使用 SQL 图扩展补齐 caller、callee、import、export、同文件邻近符号等结构关系，不把完整仓库图加载到 Extension Host。
7. 继续复用 `contextBudget.ts` 控制最终发给模型的源码片段规模。

## 非目标

1. 不引入本地业务词表，例如“模型集成 -> providerRegistry”。
2. 不直接依赖、修改或迁移 CodeGraph 的内部数据库。
3. 不把 parser、grammar、临时 AST、SQLite 连接或单次查询候选序列化到数据库。
4. 本阶段不实现 `Tree.edit()` 和字符级增量解析；Tree-sitter 仍完整解析发生变化的文件。
5. 第一版不把整文件源码全部向量化，避免 embedding 成本和噪音过高。
6. 第一版不依赖 LLM 做意图识别。LLM 查询规划可以作为后续低置信度 fallback，但不是主路径。
7. 第一版不加载 native vector 扩展；SQLite 仍是本地索引存储，图查询和小规模向量计算由数据库 worker 完成。

## 总体架构

```text
VS Code create/change/delete watcher
  -> persistent index_jobs queue
  -> read changed workspace file
  -> Tree-sitter ParserRuntime
  -> LanguageAdapter ExtractionResult
  -> CodeChunker ExtractionSnapshot
  -> SqliteIndexWorker
       diff stable ids + content hashes
       transactionally update files / nodes / edges / chunks / FTS / embeddings
  -> SqliteHybridRetriever
       exact token + FTS + optional vector + SQL graph proximity
  -> contextBudget
  -> renderCodeIntelligencePrompt
  -> model
```

Tree-sitter 抽取是代码结构事实来源，SQLite 是可恢复的索引事实源。向量召回只产生候选 `chunk_id` 或 `node_id`；最终上下文必须映射回 SQLite 中已提交的 `CodeNode`、`CodeEdge`、chunk 文本和源码范围。

## 运行时与存储边界

### VS Code 与 SQLite 基线

VS Code `1.101.0` 使用 Node 22 构建基线，能够提供 `node:sqlite`。实现同时修改：

- `package.json`：`engines.vscode` 改为 `^1.101.0`。
- `esbuild.js`：Node target 改为 `node22`，并增加数据库 worker 的独立 bundle entry。
- 扩展启动验证：真实探测 `node:sqlite`、FTS5、WAL 和 worker bundle；不能只在系统 Node 中验证。

数据库位于 `context.storageUri/loopagent-code-index.sqlite`。`storageUri` 是 VS Code 提供的工作区级存储目录，多根工作区共享同一个工作区数据库；无工作区时不创建代码索引。

数据库连接只存在于 `SqliteIndexWorker`。worker 启动后设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

### 持久化与临时状态

必须持久化：文件元数据和 hash、节点、边、import binding、未解析引用、诊断、chunk、FTS、embedding、文件依赖、schema/index 版本和更新队列。

只允许短期留在内存：Tree-sitter parser/grammar、当前文件文本、临时 AST、一次 `ExtractionSnapshot`、worker 消息、当前查询候选、上下文预算和最终 prompt。一次更新或查询结束后不得把这些对象作为仓库级缓存保留。

## SQLite 数据模型

### `files`

```text
id              text primary key
path            text not null
uri             text not null unique
language_id     text not null
content_hash    text not null
byte_length     integer not null
mtime           integer not null
index_state     text not null
extractor_ver   integer not null
chunker_ver     integer not null
indexed_at      integer not null
```

`id` 使用规范化 workspace URI 的 hash。`index_state` 取 `pending`、`indexing`、`ready`、`failed` 或 `deleted`。源码文件仍是事实源；数据库不重复保存整文件文本，只保存最终检索所需的 chunk 文本。

### `nodes`

```text
id              text primary key
file_id         text not null
semantic_key    text not null
kind            text not null
name            text not null
qualified_name  text not null
start_line      integer not null
end_line        integer not null
start_column    integer
end_column      integer
signature       text
exported        integer not null default 0
content_hash    text not null
metadata_json   text
```

`nodes` 对应现有 `CodeNode`。`semantic_key` 不包含行号，用于在代码移动后保持节点身份；`qualified_name`、`signature` 和 `exported` 用于生成 symbol card 和排序。

### `edges`

```text
id              text primary key
source_node_id  text not null
target_node_id  text not null
owner_chunk_id  text
kind            text not null
file_id         text
line            integer
confidence      text
metadata_json   text
```

`kind` 复用现有 `calls`、`imports`、`exports`、`contains` 等图边类型。边归属到产生它的符号 chunk；只有该 chunk 变化时才替换其出边。跨文件入边通过 `file_dependencies` 和持久化引用重新解析。

### `chunks`

```text
id              text primary key
file_id         text not null
node_id         text
semantic_key    text not null
chunk_kind      text not null
source_text     text not null
search_text     text not null
embedding_text  text not null
source_hash     text not null
search_hash     text not null
embedding_hash  text not null
start_line      integer
end_line        integer
token_hint      integer
updated_at      integer not null
```

`chunk_kind` 包括：

- `file_card`
- `symbol_card`
- `class_card`
- `callsite_card`
- `test_case_card`
- `source_body`

`id` 由 `file_id + chunk_kind + semantic_key` 生成，不包含行号。`source_text` 用于最终 prompt；`search_text` 额外包含 camelCase、qualified name 和路径拆词；`embedding_text` 排除行号和更新时间等易变信息。第一版优先对 card 类 chunk 做向量化；`source_body` 先进入 SQLite 和 FTS，只有在评估确认收益后再向量化。

### `chunk_fts`

使用 SQLite FTS5：

```text
chunk_fts(chunk_id unindexed, search_text)
```

FTS 使用 `unicode61` tokenizer，内容来自 card 和 source body。它负责精确标识符、路径、英文关键词、签名、导入导出名检索；写入和删除由同一个索引事务显式维护。

### `embedding_cache` 与 `chunk_embeddings`

```text
provider        text not null
model           text not null
embedding_hash  text not null
dim             integer not null
vector_blob     blob not null
created_at      integer not null
primary key(provider, model, embedding_hash)

chunk_id        text not null
provider        text not null
model           text not null
embedding_hash  text not null
status          text not null
attempts        integer not null default 0
last_error      text
updated_at      integer not null
primary key(chunk_id, provider, model)
```

embedding 按 `embedding_hash` 寻址，使代码移动、文件重命名或其他 chunk 出现相同 `embedding_text` 时可以复用向量。chunk 内容改变后，映射状态改为 `pending`，旧向量不参与召回。`vector_blob` 的查询由 `VectorIndex` 接口决定；第一版由数据库 worker 读取受控候选并计算余弦相似度，不加载 native vector 扩展。

### `import_bindings`、`unresolved_references` 与 `file_dependencies`

```text
import_bindings(id, file_id, owner_chunk_id, imported_name, local_name, module_specifier, resolved_file_id)
unresolved_references(id, file_id, owner_chunk_id, reference_name, reference_kind, line, column, metadata_json)
file_dependencies(from_file_id, to_file_id, module_specifier, kind)
```

这些表保留跨文件关系解析所需证据。文件导出变化时，只重新解析依赖文件的关系，不重新运行依赖文件的 Tree-sitter 抽取或 chunker。

### `diagnostics`

```text
id              text primary key
file_id         text
owner_chunk_id  text
severity        text not null
code            text
message         text not null
created_at      integer not null
```

诊断属于索引状态，必须在重启后仍可查询。文件或 chunk 更新时只替换对应范围的诊断。

### `index_jobs`

```text
id              integer primary key
file_uri        text not null
event_kind      text not null
status          text not null
attempts        integer not null
last_error      text
created_at      integer not null
updated_at      integer not null
unique(file_uri)
```

watcher 的 create/change/delete 事件通过 upsert 合并到该队列。连续 create/change 合并为一次最新内容更新；delete 覆盖此前的 change；delete 后路径重新出现时根据处理前的实际文件状态转为 create。worker 每次执行前重新 stat 文件，不依赖过时事件载荷。worker 崩溃或 Extension Host 退出后，`pending` 和超时的 `running` 任务在下次启动继续执行。

### `schema_migrations`

```text
version         integer primary key
description     text not null
applied_at      integer not null
```

数据库迁移必须显式、单调且可测试。无法迁移的索引数据库先改名备份，再重建；不能在未知 schema 上继续写入。

### `index_meta`

```text
key             text primary key
value           text not null
```

记录 workspace identity、schema version、extractor version、chunker version、embedding model、last successful scan、last rebuild time 和 index format。extractor/chunker 版本变化只把受影响文件标记为 `pending`；embedding model 变化只重建相应模型的 embedding。

### 外键与索引

- 所有文件所属表通过 `file_id -> files.id ON DELETE CASCADE` 清理。
- `edges.source_node_id`、`edges.target_node_id` 和 `chunks.node_id` 建立外键；可选引用使用 `ON DELETE SET NULL`，事实所属关系使用 `ON DELETE CASCADE`。
- 为 `nodes(file_id)`、`nodes(name)`、`nodes(qualified_name)`、`edges(source_node_id)`、`edges(target_node_id)`、`edges(owner_chunk_id)` 建立索引。
- 为 `chunks(file_id)`、`chunks(node_id)`、`chunks(embedding_hash)`、`file_dependencies(from_file_id)`、`file_dependencies(to_file_id)` 建立索引。
- 为 `index_jobs(status, updated_at)` 和 `chunk_embeddings(status, updated_at)` 建立队列索引。
- FTS 行与 `chunks` 行在同一事务中显式增删；测试必须断言两者不存在孤立记录。

## 稳定身份与差异算法

### 稳定语义键

- 文件：规范化 workspace URI。
- 顶层符号：`kind + qualified_name + normalized_signature`。
- 类成员：父类语义键加成员 kind、名称和 normalized signature。
- 文件卡片：固定键 `file_card`。
- 测试卡片：父级 describe 路径、测试 API 类型和测试名称。
- 超大函数子块：父符号语义键、AST 角色和规范化首个语句 hash；ordinal 只作为冲突消解，不作为首选身份。

`node_id` 和 `chunk_id` 使用上述语义键计算，不能包含行号、mtime 或索引时间。重载符号通过 normalized signature 区分。符号重命名视为删除旧身份并创建新身份。

### 内容 hash 分层

每个 chunk 计算三个独立 hash：

1. `source_hash`：准确源码文本，用于判断 prompt 内容是否变化。
2. `search_hash`：FTS `search_text`，用于判断是否更新 FTS。
3. `embedding_hash`：稳定的 `embedding_text`，用于判断是否重新生成 embedding。

行号和范围单独保存。仅在文件前插入空行时，只更新范围，不触发 FTS 或 embedding；函数体变化时更新 `source_hash`，并根据 card 内容是否变化决定后续索引更新。

### 文件快照差异

Tree-sitter 和 adapter 为变化文件生成一次完整 `ExtractionSnapshot`，内容按 owner chunk 分组：节点、出边、import binding、未解析引用、诊断和 chunk 文本。worker 在事务内将新旧稳定 ID 分为：

- `unchanged`：所有 hash 相同，不写 chunk/FTS/embedding。
- `metadata-only`：只更新范围或非检索元数据。
- `search-changed`：更新 chunk 与 FTS，embedding 可继续复用。
- `embedding-changed`：更新 chunk、FTS，并把 embedding 映射标记为 `pending`。
- `added`：插入完整记录。
- `removed`：删除所属节点、出边、引用、诊断、chunk 和映射；内容寻址的 `embedding_cache` 可由回收任务延迟清理。

文件删除在一个事务内级联清理全部文件索引。文件重命名按 delete/create 处理，但相同 `embedding_hash` 可以复用已有向量。

## 切块规则

### `file_card`

每个文件生成一个。内容包含：

```text
file: src/extension/model/providerRegistry.ts
language: typescript
exports: createConfiguredAgentRunner, createDeepSeekProvider
imports: createModelRunner, createOpenAiCompatibleClient
topLevelSymbols: ...
responsibilityHints: model, provider, registry, runner, client
```

`responsibilityHints` 不来自人工词表，而是从路径段、文件名、导出名、导入名和符号名拆词得到。

### `symbol_card`

每个函数、方法、类、接口、类型别名生成一个。内容包含：

```text
kind: function
name: createConfiguredAgentRunner
qualifiedName: src/extension/model/providerRegistry.ts::createConfiguredAgentRunner
file: src/extension/model/providerRegistry.ts
signature: ...
exports: true
imports: createModelRunner, createDeepSeekProvider
calls: createModelRunner, createDeepSeekProvider
nearbySymbols: ...
sourceRange: 42-96 (query-time metadata)
```

这是向量召回的主单元。它比原始源码更适合处理中文抽象问题，因为它把符号名、调用关系、模块路径和职责线索压缩在同一段检索文本里。`sourceRange` 不写入 `source_text`、`search_text` 或 `embedding_text`，而是由查询渲染器根据 range 列动态补入展示文本，避免纯行号移动触发任何内容 hash。

### `class_card`

每个类生成一个结构摘要，包含 constructor、methods、fields、extends、implements、重要调用关系。类方法仍各自生成 `symbol_card`。

### `callsite_card`

对关键调用点生成小卡片，第一版只做通用模式，不做框架专用补边：

- 工厂调用：`createX(...)`
- 注册调用：`registerX(...)`
- provider/client/runner/config 组合调用
- 顶层对象配置中的函数引用

`callsite_card` 用 AST 调用表达式生成，不使用业务词表。

### `test_case_card`

测试文件中按 `describe`、`it`、`test` 生成测试卡片，记录被测 imports、测试名、断言关键词和相关 symbol。用于回答“这个行为怎么测”“哪些测试覆盖了模型接入”等问题。

### `source_body`

源码体不作为第一版向量主单元，但保留在 SQLite 中用于最终上下文取片段。

规则：

1. 小函数或方法整体作为一个 `source_body`，上限约 `120` 行或 `4000` 字符。
2. 超大函数按 AST 子块切分，例如 `if`、`for`、`try`、`switch`、callback、object literal。
3. 子块目标大小 `1500-3000` 字符，硬上限 `5000` 字符。
4. 子块必须带父级函数签名、`qualifiedName` 和源码范围。
5. overlap 只用于源码上下文，默认前后 `6-12` 行，不作为主要向量语义。

## 混合召回

查询流程：

```text
query
  -> normalized exact-token / FTS search in SQLite
  -> optional vector search in database worker
  -> RRF / weighted fusion
  -> chunk -> node 映射
  -> indexed edge query / bounded recursive CTE
  -> contextBudget
```

推荐融合信号：

| 信号 | 作用 |
| --- | --- |
| SQLite exact token | 快速命中明确代码标识符、qualified name 和拆分后的 camelCase |
| FTS5 | 命中路径、签名、导入导出、测试名和 card 文本 |
| Vector | 命中中文、抽象问题、语义相似职责 |
| Graph proximity | 提升 caller/callee/import/export 相关节点 |
| Node kind | exported function、class、file card 优先 |
| File path | `src/extension/model` 等路径相关性 |

第一版可以使用 RRF：

```text
score = 1 / (k + exact_rank)
      + 1 / (k + fts_rank)
      + 1 / (k + vector_rank)
      + graph_bonus
```

其中 `k` 默认 `60`，避免单一路径分数过大。查询只把预算允许的候选节点、关系和 chunk 文本传回 Extension Host；禁止提供“读取完整图快照”的生产接口。

## 向量实现取舍

### 第一阶段

使用 `node:sqlite` 持久化向量和映射，不加载 native vector 扩展：

```text
EmbeddingProvider
  embed(texts: string[]): Promise<number[][]>

VectorIndex
  bindEmbedding(chunkId, provider, model, embeddingHash)
  search(vector, limit): Promise<VectorHit[]>

SqliteIndexWorkerClient
  initialize(storageUri)
  enqueueChanges(changes)
  applyFileSnapshot(snapshot)
  removeFile(fileUri)
  searchFts(query, limit)
  expandGraph(nodeIds, depth, limits)
  getChunks(chunkIds)
  getStatus()
  dispose()
```

第一阶段由 worker 每批最多读取 `256` 个 card embedding，维护有界 top-k 并计算余弦相似度，向量只在单次查询期间存在于 worker 内存。默认最多扫描 `20,000` 个 card；超过上限时跳过全量向量扫描并记录诊断，FTS 和图查询仍可用。

### 第二阶段

评估 `sqlite-vec` 或其他 SQLite vector 扩展的 VS Code 打包成本。只有在 Windows/macOS/Linux Extension Development Host 和打包后都验证通过，才允许替换 worker 余弦实现；该评估不阻塞 SQLite、FTS 和 embedding 持久化。

## 增量更新

watcher 不再只维护内存 `dirtyPaths` 和 `deletedPaths`，而是将事件合并写入 `index_jobs`。启动扫描也把新增、修改和删除差异写入同一队列。

文件变更时：

```text
changed file
  -> compare size + mtime
  -> metadata changed: read file and compute content_hash
  -> content unchanged: update metadata and finish
  -> content changed:
       parse whole changed file with Tree-sitter
       build ExtractionSnapshot grouped by stable chunk id
       diff old/new nodes, edges, chunks and hashes
       transactionally apply only changed rows and FTS entries
       mark only changed embedding mappings pending
       re-resolve relationships for impacted dependent files
```

写事务开始前已经完成的查询读取旧版本；事务执行期间到达的查询在 worker 队列中等待；提交后读取新版本。任何查询都不会看到半完成状态。删除文件时，在一个事务内级联删除对应 `file_id` 下的全部记录并重新解析受影响的依赖关系。

embedding 任务异步执行，不阻塞用户提问。若 embedding 尚未完成，检索退化为 exact token + FTS + graph。worker 或 Extension Host 在事务中断后依靠 WAL 回滚，并在下次启动重试持久化队列。

## 并发、生命周期与恢复

1. 一个 `SqliteIndexWorker` 独占当前 Extension Host 的数据库连接，所有写操作通过串行消息队列执行。
2. 查询消息与写消息共用串行 worker 队列。查询只在事务边界执行，并且只读取已提交状态。
3. `index_meta` 保存 writer owner 和租约时间。两个窗口意外打开同一工作区数据库时，只有持有有效租约的 worker 执行索引，其他实例只读并定期重试租约。
4. 扩展启动先运行 migration 和能力探测，再恢复 `pending` 任务及超时的 `running` 任务，最后执行工作区差异扫描。
5. 扩展关闭时停止接收新任务、完成或回滚当前事务、释放租约、checkpoint WAL 并关闭连接；不得删除数据库。
6. schema 迁移失败时关闭原库并保留带时间戳的备份，再创建新库和全量重建任务。

## 安全与清理

- 继续复用 `.env`、secret、token、API key、构建目录和依赖目录排除规则，排除文件不得写入 `files` 或任何 chunk 表。
- 数据库只位于 VS Code 工作区存储目录，不进入仓库、不参与 Settings Sync，也不记录到普通日志。
- 日志只记录文件相对路径、row count、耗时、状态和错误，不输出 chunk 源码或 embedding。
- 提供 `LoopAgent: Rebuild Code Index`、`LoopAgent: Clear Code Index` 和 `LoopAgent: Show Code Index Status` 命令。
- `Clear` 必须先停止 worker 并关闭连接，再删除主库、WAL 和 SHM；`Rebuild` 保留旧库直到新库初始化成功。

## 与现有代码的关系

新增模块建议放在：

```text
src/extension/intelligence/storage/indexSchema.ts
src/extension/intelligence/storage/indexMigrations.ts
src/extension/intelligence/storage/sqliteIndexWorker.ts
src/extension/intelligence/storage/sqliteIndexWorkerClient.ts
src/extension/intelligence/indexing/workspaceIndexer.ts
src/extension/intelligence/indexing/extractionSnapshot.ts
src/extension/intelligence/chunking/codeChunker.ts
src/extension/intelligence/retrieval/hybridRetriever.ts
src/extension/intelligence/retrieval/vectorIndex.ts
src/extension/intelligence/embedding/embeddingProvider.ts
```

现有模块调整：

- `workspaceIntelligence.ts` 仍是模型上下文入口，但只协调 indexer、retriever、预算和 prompt，不拥有仓库级 Map。
- `vscodeWorkspaceIntelligence.ts` 只负责工作区扫描、文件读取和 watcher 事件，不保留源码、dirty 或 deleted 常驻缓存。
- `semanticGraph.ts` 与 `graphTraverser.ts` 的生产调用改为有界 SQL 图查询；没有消费者后删除文件和过期测试。
- `searchIndex.ts` 的标识符拆词逻辑迁入 chunk `search_text` 生成；生产路径切换后删除完整内存索引。
- `codeIntelligenceContext.ts` 接收 retriever 返回的有界节点、关系和 chunk，不再接收完整 `SemanticGraph` 与 `SearchIndex`。
- `contextBudget.ts` 继续决定最终上下文规模。
- `codeIntelligencePrompt.ts` 增加检索元信息展示，例如召回路径、是否使用向量、chunk 类型统计。
- `extension.ts` 把 `context.storageUri` 传入 workspace intelligence，并把其 `dispose()` 注册到 `context.subscriptions`。

实现迁移期间可以在测试中保留纯内存 fixture，但生产代码不得同时维护 SQLite 和完整内存索引两套事实源。旧模块只能在全部消费者迁移后删除，避免一次大改导致上下文链路无法验证。

## 失败与降级

1. `node:sqlite`、worker、WAL 或 FTS5 能力探测失败：持久化索引状态设为 `failed`，显示可操作诊断，只保留现有当前文件运行时上下文；不得静默创建完整内存索引。
2. schema migration 失败：备份旧库并重建，不在未知 schema 上继续读写。
3. 单文件抽取失败：保留该文件上一版已提交索引，把 job 标记为 `failed` 并记录诊断；下一次文件变化或手动 rebuild 时重试。
4. Embedding provider 未配置或暂时失败：跳过向量召回，exact token、FTS 和 graph 继续工作，pending 任务保留重试信息。
5. card 数量超过 worker 余弦扫描上限：跳过全量向量扫描并记录诊断，不把所有 vector 加载到 Extension Host。
6. 混合召回没有命中：prompt 明确标记“未命中代码上下文”，避免模型泛泛回答。

## 验证策略

单元测试：

1. `indexMigrations.test.ts`：在临时目录中创建、升级和拒绝未知 schema，验证 WAL、foreign key 和 FTS5。
2. `codeChunker.test.ts`：验证 file、function、class、method、test case、超大函数子块的稳定 ID 和三层 hash。
3. `snapshotDiff.test.ts`：分别覆盖 unchanged、metadata-only、search-changed、embedding-changed、added 和 removed。
4. `sqliteIndexWorker.test.ts`：验证事务回滚、持久化 job 恢复、文件增删改和级联约束。
5. `sqliteFts.test.ts`：验证路径、qualified name、camelCase、签名、导入导出和中文 card 检索。
6. `dependencyResolution.test.ts`：验证导出变化只重新解析受影响关系，不重新抽取依赖文件。
7. `hybridRetriever.test.ts`：验证 exact token、FTS、vector hit 和 graph proximity 的 RRF 融合排序及硬预算。
8. `workspaceIntelligence.test.ts`：验证持久化索引不会破坏现有 prompt 生成链路，且生产对象不保存完整仓库 Map。

集成测试：

1. 首次索引后重启扩展，未变化文件不重新运行 parser 或 chunker。
2. 一个文件包含多个函数时，只修改一个函数体，只有对应 chunk、出边、FTS 和 embedding 状态变化；其他 chunk 的 ID、hash 和 embedding 创建时间保持不变。
3. 只在文件前增加空行时，只更新范围，不更新 FTS 或 embedding。
4. 新增、删除、重命名文件或符号后，没有旧 chunk、孤立边、错误 FTS hit 或失效 embedding 映射。
5. 索引事务中途抛错后，查询仍得到完整旧版本；重启后 job 能继续。
6. 用当前项目提问“模型集成是怎么实现的”，应命中 `providerRegistry.ts`、`modelRunner.ts`、`openAiCompatibleClient.ts` 等真实代码上下文。
7. 用明确标识符 `assistantDelta` 提问，仍走 exact token/FTS 路径，不因为向量层引入额外噪音。
8. 不配置 embedding provider 时，exact token、FTS 和 graph 仍可用。
9. 被敏感规则排除的文件不会出现在任一 SQLite 表中。

真实模型测试：

1. 在最低支持的 VS Code `1.101.x` 与当前 VS Code 中验证 Extension Host 可以加载 `node:sqlite`、数据库 worker、FTS5 和 WAL。
2. 使用唯一的 LoopAgent Extension Development Host，按项目规则通过 `npm run debug:vscode` 完成重启复用、保存单函数修改、新增文件、删除文件和索引命令验证。
3. 打包 VSIX 后重新验证 worker bundle、数据库创建、重启复用和 FTS 查询，不接受只在源码测试环境通过。
4. 记录发送给 DeepSeek 的完整 system prompt 和 user prompt，以及 exact/FTS/vector/graph 各自命中的 chunk 和 node。
5. 对比持久化前后的启动解析文件数、SQLite 写入 row 数、embedding 请求数、`systemChars`、关键源码命中率和回答准确性。

完成声明前统一执行：

```powershell
npm ci
npm test
npm run typecheck
npm run compile
git diff --check
```

## 分阶段落地

### 阶段 0：运行时基线验证

提升 VS Code/Node target，在真实 Extension Host 和打包 VSIX 中验证 `node:sqlite`、worker、FTS5、WAL 和工作区存储路径。该阶段失败时停止后续实施并返回架构决策，不自动引入其他驱动或兼容性猜测代码。

### 阶段 1：SQLite worker、schema 与迁移

实现 worker client、schema、migration、PRAGMA、租约、持久化 job 和生命周期。先用手工 `ExtractionSnapshot` fixture 验证事务与恢复。

### 阶段 2：稳定 chunk 与差异更新

实现 `CodeChunker`、稳定语义键、三层 hash、文件快照差异、跨文件依赖重解析，以及新增/修改/删除 watcher 到持久化队列的链路。

### 阶段 3：SQLite 检索与内存索引迁移

实现 exact token、FTS 和 SQL 图扩展，迁移 `createCodeIntelligenceContext`，随后删除生产路径的 `sourceCache`、`extractionCacheByFile`、完整 `SemanticGraph` 和 `SearchIndex`。

### 阶段 4：Embedding 生命周期与向量召回

实现 `EmbeddingProvider`、内容寻址的 embedding cache、pending/retry 状态和 worker 余弦召回。未配置 provider 时不影响主链路。

### 阶段 5：命令、恢复与真实宿主验证

实现 rebuild/clear/status 命令，验证崩溃恢复、重启复用、最低 VS Code、当前 VS Code、打包 VSIX 和唯一调试窗口工作流。

### 阶段 6：真实对话复测与清理

重新测试“模型集成是怎么实现的”等中文抽象问题，输出完整报告；删除迁移后无消费者的内存索引代码、过期测试、临时脚本和不一致文档。

## 关键取舍

1. 向量不是事实源，只是召回入口；事实源仍是 Tree-sitter 抽取出的节点、边和源码范围。
2. 不 embed 整文件，避免成本高、噪音大、命中后上下文不可控。
3. 参考 CodeGraph 的存储模式但维护独立 schema，不把插件绑定到外部 CLI 或其数据库版本。
4. 通过提高最低 VS Code 版本使用 `node:sqlite`，避免 native npm addon 的 ABI 和多平台打包负担。
5. 文件解析保持简单可靠的整文件 AST 路径，数据库更新、FTS 和 embedding 才采用 chunk 粒度。
6. SQLite 是唯一持久化索引事实源，不维护一套静默分叉的完整内存索引。
7. 不引入本地业务词表，避免维护成本和隐性偏置。
8. 混合召回失败时必须显式告知没有代码上下文，而不是让模型通用回答。
