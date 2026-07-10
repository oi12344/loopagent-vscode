# SQLite 检索与模型上下文设计

> 状态：设计和实施计划已批准，等待执行。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-11-sqlite-index-retrieval-context-plan.md`
>
> 前置规格：存储与 worker、稳定 chunk 与 snapshot、工作区增量索引。

## 目标

在不加载完整仓库图或 token Map 的前提下，通过 SQLite exact token、FTS5 和有界图扩展生成稳定、可解释且受预算限制的模型代码上下文。该链路在没有 embedding provider 时必须完整可用。

## 范围

1. 查询规范化、exact token 和安全 FTS5 检索。
2. 候选 chunk 到 node 的映射。
3. 有界 SQL caller/callee/import/export 图扩展。
4. 不依赖 vector 的基础 `HybridRetriever` 与 RRF 排序。
5. 模型上下文、预算、trace 和 prompt 迁移。
6. 删除生产路径对完整 `SemanticGraph`、`SearchIndex` 和源码缓存的依赖。

本规格不生成 embedding、不实现远程 provider，也不负责扩展命令。

## 查询流程

```text
query
  -> normalized exact-token search
  -> FTS5 search
  -> optional VectorCandidateSource
  -> deterministic fusion
  -> chunk -> node mapping
  -> bounded SQL graph expansion
  -> contextBudget
  -> prompt
```

`VectorCandidateSource` 在本规格中只是可选接口。未注入时不产生 vector hit 或伪造 vector trace。

## 检索 DTO

```ts
type RetrievalSource = "exact" | "fts" | "vector" | "graph";

type RetrievalHit = {
  chunkId: string;
  nodeId?: string;
  filePath: string;
  qualifiedName?: string;
  chunkKind: CodeChunkKind;
  source: RetrievalSource;
  rank: number;
  score: number;
};

type RetrievedCodeContext = {
  hits: RetrievalHit[];
  entryNodes: CodeNode[];
  relatedNodes: CodeNode[];
  edges: CodeEdge[];
  chunks: RetrievedChunk[];
  trace: RetrievalTrace;
  diagnostics: RetrievalDiagnostic[];
  truncated: boolean;
};

type RetrievalDiagnostic = {
  code: string;
  message: string;
};

type VectorCandidateResult = {
  hits: RetrievalHit[];
  diagnostics: RetrievalDiagnostic[];
};

type RetrievedChunk = {
  chunkId: string;
  nodeId?: string;
  filePath: string;
  chunkKind: CodeChunkKind;
  sourceText: string;
  startLine?: number;
  endLine?: number;
  tokenHint: number;
};

type RetrievalTrace = {
  sources: RetrievalSource[];
  candidateCounts: Partial<Record<RetrievalSource, number>>;
  truncatedBy: string[];
};
```

worker RPC 只返回扁平、可结构化克隆、已经受 limit 限制的 DTO。

## Exact Token

查询和 `search_text` 使用同一套确定性拆词规则：camelCase、PascalCase、snake_case、kebab-case、qualified name、路径段和扩展名。

明确标识符、路径或 qualified name 优先 exact。查询不能读取所有 chunk 后在 Extension Host 过滤；SQL 必须带显式 `LIMIT`。

## FTS5

FTS 负责路径、签名、import/export、测试名、英文关键词和 card/source body 文本。

用户输入转换为受控 FTS 表达式：

1. token 由应用层规范化。
2. 特殊字符按 FTS5 规则转义或丢弃。
3. 原始输入不拼接到 SQL；普通 SQL 参数始终绑定。
4. 空查询、全符号查询和无合法 token 查询返回空候选，不执行无界 match。

每条检索都要求 `limit`，查询统计要能证明 worker 只加载返回所需的有界行。

## 有界 SQL 图扩展

入口 node 来自 exact/FTS/optional vector 候选。扩展关系包括 caller、callee、import、export、contains 和同文件邻近符号。

生产 API 必填：

```ts
type GraphBudget = {
  depth: number;
  maxNodes: number;
  maxEdges: number;
};

type RetrievedGraph = {
  nodes: CodeNode[];
  edges: CodeEdge[];
  truncated: boolean;
  truncatedBy: Array<"depth" | "nodes" | "edges">;
};
```

实现使用 source/target/owner 索引和有界 recursive CTE。深度、node 数或 edge 数达到预算立即截断，并在 trace 中记录。禁止返回完整图快照。

## 基础 HybridRetriever

基础阶段融合 exact、FTS 和 graph。推荐 RRF：

```text
score = 1 / (60 + exact_rank)
      + 1 / (60 + fts_rank)
      + optional_vector_term
      + graph_bonus
```

规则：

1. 缺失来源不贡献分数。
2. 相同分数按 stable chunk ID 排序。
3. node kind 和 file path 只能作为明确、可测试的轻量 bonus，不能覆盖强 exact hit。
4. optional vector 的注入契约在本规格定义，具体实现归 embedding 规格。
5. 没有 vector 时相同 exact/FTS/graph 输入必须产生确定性结果。

接口：

```ts
type VectorCandidateSource = {
  search(query: string, limit: number): Promise<VectorCandidateResult>;
};

type HybridRetriever = {
  retrieve(query: string, profile: CodeIntelligenceBudgetProfile): Promise<RetrievedCodeContext>;
};
```

## 上下文构建

`createCodeIntelligenceContext` 只接收已经取回的有界结果：

```ts
createCodeIntelligenceContext(options: {
  query: string;
  retrieved: RetrievedCodeContext;
  maxChars?: number;
}): CodeIntelligenceResult;
```

它只做 snippet 排序、去重、行数/字符裁剪和无命中 fallback，不读取工作区源码、不遍历数据库，也不拥有图索引。

继续复用 `contextBudget.ts`。预算至少控制 entry node、related node、edge、chunk、单 snippet 字符和总 prompt 字符。

## Prompt 与 Trace

prompt 展示：

- 索引状态和 generation。
- exact/FTS/vector/graph 实际使用的来源。
- chunk 类型统计和截断状态。
- 文件相对路径、qualified name、范围和源码片段。

不得输出数据库绝对路径、密钥、完整向量或被排除文件。没有命中时明确标记“未命中代码上下文”，避免让模型把通用知识伪装成仓库事实。

## 查询与更新并发

查询和写入共用 worker 串行队列，只在事务边界读取已提交版本。查询前最多等待 pending index job 2,000ms；超时使用上一版已提交索引，并把状态标记为 `partial`。

read-only 实例正常查询。索引 failed 时只保留已有当前文件运行时上下文，不创建完整内存仓库索引。

## 生产迁移

`workspaceIntelligence.ts` 只协调 indexer、retriever、预算和 prompt。provider registry 必须复用扩展注入的同一个 `WorkspaceIntelligence`，不能为每次请求新建 worker。

生产入口切换并验证后删除以下常驻实现或调用：

- `sourceCache`、`dirtyPaths`、`deletedPaths`。
- `extractionCacheByFile`。
- 完整 `SemanticGraph` 和 `graphTraverser`。
- 完整 `SearchIndex`。

仍被 chunker 使用的纯拆词 helper 移入 `chunking/searchText.ts`。测试 fixture 可以使用小型内存数据，但生产对象不得暴露完整图读取接口。

## 失败与降级

- FTS 查询语法无效：规范化为安全空结果，不泄露 SQL。
- 图扩展超预算：返回已收集候选并标记 truncated。
- optional vector 不存在或失败：继续 exact + FTS + graph。
- pending job 超过等待预算：读取上一版并标记 partial。
- 全部来源无命中：生成明确无上下文结果。

## 验证

1. 路径、qualified name、camelCase、签名、import/export 和测试名可被检索。
2. FTS 特殊字符和恶意输入不能改变 SQL 或产生无界查询。
3. 100 个以上 card 查询只加载 `limit` 允许的行。
4. 图扩展严格遵守 depth、maxNodes、maxEdges。
5. 没有 vector source 时 exact、FTS、graph 的 RRF 排序稳定且 trace 不含 vector。
6. 明确标识符 `assistantDelta` 保持 exact/FTS 优先。
7. `createCodeIntelligenceContext` 只消费 retrieved DTO，并继续遵守原有字符预算。
8. pending 超时使用旧提交版本并标记 partial。
9. 源级约束确认生产入口不再创建完整图、SearchIndex 或仓库源码 Map。

## 完成门禁

本规格完成后，即使完全没有 embedding 配置，用户也能获得持久化、可解释、有界的代码上下文；后续向量阶段只能增强候选，不得改变该基础保证。
