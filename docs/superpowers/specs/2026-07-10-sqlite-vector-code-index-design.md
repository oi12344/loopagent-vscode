# SQLite 持久化与向量代码索引设计

## 背景

当前代码智能索引已经具备 Tree-sitter 增量解析、内存语义图、轻量搜索索引和上下文预算层。真实 DeepSeek 测试证明，明确包含代码标识符的问题可以命中相关源码；但纯自然语言问题，例如“模型集成是怎么实现的”，因为没有 `providerRegistry`、`modelRunner` 等代码 token，当前词法索引无法召回代码上下文，模型会退化为通用回答。

不采用本地业务词表作为长期方案。本地词表虽然可以快速修复“模型集成”这类单点问题，但会把项目知识硬编码到规则里，后续每新增一个业务域都要人工维护，容易变成不可控的别名库。

本设计目标是引入 SQLite 持久化索引、FTS 和可插拔向量召回，用自动生成的结构化代码 chunk 替代人工业务词表，让中文、英文、模糊自然语言问题都能先召回真实代码入口，再通过语义图扩展和预算层生成最终上下文。

## 目标

1. 使用 SQLite 持久化 `files`、`nodes`、`edges`、`chunks`、`fts`、`embeddings` 等索引数据，避免每次请求重建完整内存索引。
2. 使用 AST 符号优先切块，生成适合检索的 `file_card`、`symbol_card`、`class_card`、`callsite_card`、`test_case_card`。
3. 使用 FTS 处理精确标识符、路径、签名和关键字检索。
4. 使用向量召回处理中文和抽象自然语言查询，向量只负责找候选入口，不直接决定最终回答事实。
5. 使用图扩展补齐 caller、callee、import、export、同文件邻近符号等结构关系。
6. 继续复用 `contextBudget.ts` 控制最终发给模型的源码片段规模。

## 非目标

1. 第一版不引入本地业务词表，例如“模型集成 -> providerRegistry”。
2. 第一版不要求完整替换当前内存图，可以先实现持久化 store，再逐步切换查询路径。
3. 第一版不把整文件源码全部向量化，避免 embedding 成本和噪音过高。
4. 第一版不依赖 LLM 做意图识别。LLM 查询规划可以作为后续低置信度 fallback，但不是本设计的主路径。
5. 第一版不做复杂图数据库，SQLite 仍是本地索引存储，语义图查询由 TypeScript 层完成。

## 总体架构

```text
workspace files
  -> Tree-sitter ParserRuntime
  -> LanguageAdapter ExtractionResult
  -> PersistentIndexStore(SQLite)
       files / nodes / edges / chunks / chunk_fts / embeddings
  -> HybridRetriever
       lexical search + FTS + vector search + graph proximity
  -> graph expansion
       callers / callees / import / export / same-file related symbols
  -> contextBudget
  -> renderCodeIntelligencePrompt
  -> model
```

SQLite 是事实缓存和检索索引；Tree-sitter 抽取仍是代码结构事实源；向量召回只产生候选 `chunk_id` 或 `node_id`；最终上下文必须映射回真实 `CodeNode`、`CodeEdge` 和源码范围。

## SQLite 数据模型

### `files`

```text
id              text primary key
path            text not null unique
language_id     text not null
content_hash    text not null
byte_length     integer not null
updated_at      integer not null
```

`id` 可以使用稳定的 path hash。文件内容变化时，删除并重建该文件下的 nodes、edges、chunks 和 embeddings。

### `nodes`

```text
id              text primary key
file_id         text not null
kind            text not null
name            text not null
qualified_name  text not null
start_line      integer not null
end_line        integer not null
signature       text
exported        integer not null default 0
```

`nodes` 对应现有 `CodeNode`。`qualified_name`、`signature` 和 `exported` 用于生成 symbol card 和排序。

### `edges`

```text
id              text primary key
source_node_id  text not null
target_node_id  text not null
kind            text not null
file_id         text
line            integer
```

`kind` 复用现有 `calls`、`imports`、`exports`、`contains` 等图边类型。

### `chunks`

```text
id              text primary key
file_id         text not null
node_id         text
chunk_kind      text not null
text            text not null
content_hash    text not null
start_line      integer
end_line        integer
token_hint      integer
```

`chunk_kind` 包括：

- `file_card`
- `symbol_card`
- `class_card`
- `callsite_card`
- `test_case_card`
- `source_body`

第一版优先对 card 类 chunk 做向量化；`source_body` 先进入 SQLite 和 FTS，只有在后续评估确认收益后再向量化。

### `chunk_fts`

使用 SQLite FTS5：

```text
chunk_fts(chunk_id, text)
```

FTS 文本来自 card 和 source body。它负责精确标识符、路径、英文关键词、签名、导入导出名检索。

### `embeddings`

```text
chunk_id        text not null
model           text not null
dim             integer not null
vector_blob     blob not null
content_hash    text not null
created_at      integer not null
primary key(chunk_id, model)
```

`vector_blob` 的具体查询方式由 `VectorIndex` 接口决定。可以先保存 blob，再根据实际打包可行性接入 `sqlite-vec` 或其他 SQLite vector 扩展。

### `index_meta`

```text
key             text primary key
value           text not null
```

记录 schema version、embedding model、last full rebuild time、index format 等信息。

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
sourceRange: 42-96
```

这是向量召回的主单元。它比原始源码更适合处理中文抽象问题，因为它把符号名、调用关系、模块路径和职责线索压缩在同一段检索文本里。

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
  -> lexical token search
  -> FTS chunk search
  -> vector chunk search
  -> RRF / weighted fusion
  -> chunk -> node 映射
  -> graph expansion
  -> contextBudget
```

推荐融合信号：

| 信号 | 作用 |
| --- | --- |
| 当前 `SearchIndex` | 快速命中明确代码标识符 |
| FTS5 | 命中路径、签名、导入导出、测试名 |
| Vector | 命中中文、抽象问题、语义相似职责 |
| Graph proximity | 提升 caller/callee/import/export 相关节点 |
| Node kind | exported function、class、file card 优先 |
| File path | `src/extension/model` 等路径相关性 |

第一版可以使用 RRF：

```text
score = 1 / (k + lexical_rank)
      + 1 / (k + fts_rank)
      + 1 / (k + vector_rank)
      + graph_bonus
```

其中 `k` 默认 `60`，避免单一路径分数过大。

## 向量实现取舍

### 第一阶段

先定义接口，不绑定具体 native 扩展：

```text
EmbeddingProvider
  embed(texts: string[]): Promise<number[][]>

VectorIndex
  upsertEmbedding(chunkId, model, vector, contentHash)
  search(vector, limit): Promise<VectorHit[]>

PersistentIndexStore
  upsertFileIndex(...)
  searchFts(query, limit)
  getChunks(...)
  getGraphSnapshot(...)
```

SQLite 先持久化 `vector_blob`。如果没有可用向量查询扩展，第一阶段可以在小仓库中把候选向量读入内存做余弦相似度，作为功能验证路径。

### 第二阶段

评估 `sqlite-vec`、`sqlite-vss` 或其他 SQLite vector 扩展的 VS Code 打包成本。只有在 Windows/macOS/Linux Extension Development Host 和打包后都验证通过，才启用 native vector 查询路径。

## 增量更新

文件变更时：

```text
changed file
  -> compute content_hash
  -> unchanged: skip
  -> changed:
       delete old file nodes/edges/chunks/embeddings
       parse + extract
       write files/nodes/edges/chunks/fts
       enqueue embedding jobs for changed card chunks
```

删除文件时，删除对应 `file_id` 下所有索引记录。

embedding 任务应异步执行，不阻塞用户提问。若 embedding 尚未完成，检索退化为 lexical + FTS + graph。

## 与现有代码的关系

新增模块建议放在：

```text
src/extension/intelligence/storage/sqliteIndexStore.ts
src/extension/intelligence/chunking/codeChunker.ts
src/extension/intelligence/retrieval/hybridRetriever.ts
src/extension/intelligence/retrieval/vectorIndex.ts
src/extension/intelligence/embedding/embeddingProvider.ts
```

现有模块保留：

- `workspaceIntelligence.ts` 仍是模型上下文入口。
- `semanticGraph.ts` 仍负责图模型和遍历。
- `searchIndex.ts` 仍保留为内存快速检索路径。
- `contextBudget.ts` 继续决定最终上下文规模。
- `codeIntelligencePrompt.ts` 增加检索元信息展示，例如召回路径、是否使用向量、chunk 类型统计。

## 失败与降级

1. SQLite 初始化失败：退回现有内存索引。
2. FTS 不可用：退回 `SearchIndex`。
3. Embedding provider 未配置：跳过向量召回。
4. Vector 扩展不可用：小仓库可用内存余弦验证；大仓库直接跳过向量。
5. 混合召回没有命中：prompt 明确标记“未命中代码上下文”，避免模型泛泛回答。

## 验证策略

单元测试：

1. `codeChunker.test.ts` 验证 file、function、class、method、test case 的 chunk 生成。
2. `sqliteIndexStore.test.ts` 验证文件增删改后 nodes、edges、chunks、fts 一致。
3. `hybridRetriever.test.ts` 验证 lexical、FTS、vector hit 的 RRF 融合排序。
4. `workspaceIntelligence.test.ts` 验证持久化索引不会破坏现有 prompt 生成链路。

集成测试：

1. 用当前项目提问“模型集成是怎么实现的”，应命中 `providerRegistry.ts`、`modelRunner.ts`、`openAiCompatibleClient.ts` 等真实代码上下文。
2. 用明确标识符 `assistantDelta` 提问，仍走快速词法/FTS 路径，不因为向量层引入额外噪音。
3. 修改单个文件后，只重建该文件相关索引和 embeddings。
4. 不配置 embedding provider 时，系统仍可用。

真实模型测试：

1. 记录发送给 DeepSeek 的完整 system prompt 和 user prompt。
2. 记录召回路径：lexical/FTS/vector/graph 各自命中的 chunk 和 node。
3. 对比向量前后的 `systemChars`、`sourceSnippetCount`、关键源码命中率和回答准确性。

## 分阶段落地

### 阶段 1：SQLite 持久化与 chunk

实现 `PersistentIndexStore`、schema、chunk 生成和 FTS。暂不接真实向量扩展。

### 阶段 2：HybridRetriever

接入 lexical + FTS + graph proximity，替换 `createCodeIntelligenceContext` 中单一 `searchIndex.search(query)` 的入口选择逻辑。

### 阶段 3：Embedding 与向量召回

实现 `EmbeddingProvider` 和 `VectorIndex` 接口。优先支持可配置 provider；未配置时不影响主链路。

### 阶段 4：SQLite vector 扩展评估

验证 `sqlite-vec` 或替代方案在 VS Code extension 打包环境中的可用性。通过后再启用真正 SQLite 内向量查询。

### 阶段 5：真实对话复测

重新测试“模型集成是怎么实现的”等中文抽象问题，输出完整报告，确认不依赖本地业务词表也能召回真实代码上下文。

## 关键取舍

1. 向量不是事实源，只是召回入口；事实源仍是 Tree-sitter 抽取出的节点、边和源码范围。
2. 不 embed 整文件，避免成本高、噪音大、命中后上下文不可控。
3. 第一版先保证 SQLite + FTS + chunk 可靠，再接 native vector，降低 VS Code 打包风险。
4. 不引入本地业务词表，避免维护成本和隐性偏置。
5. 混合召回失败时必须显式告知没有代码上下文，而不是让模型通用回答。
