# SQLite 检索与模型上下文实施计划

> **Agent 执行要求：** 在既有 SQLite feature worktree 中执行，选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。逐任务 RED -> GREEN -> REFACTOR。

**目标：** 实现不依赖 embedding 的 exact/FTS/SQL graph 混合检索，并把模型上下文入口迁移到有界 SQLite DTO。

**架构：** worker 执行所有有界 SQL，Extension Host 的 `HybridRetriever` 融合排名、请求图扩展并交给原有预算层。向量仅以 optional interface 出现，本计划不实现 vector hit。

**技术栈：** TypeScript、SQLite FTS5、recursive CTE、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-retrieval-context-design.md`

**前置门禁：** workspace 增量计划完成，数据库中能够持续维护 nodes、edges、chunks 和 FTS。

---

## 文件职责

- `retrievalTypes.ts`：有界 hit、trace、context 和 optional vector contract。
- `sqliteRetriever.ts`：exact/FTS/getChunks RPC adapter。
- `sqliteGraphQuery.ts`：有界 recursive CTE 和图 DTO。
- `hybridRetriever.ts`：基础 RRF、graph bonus、预算和 trace。
- `codeIntelligenceContext.ts`：只消费已取回 DTO，裁剪 snippet。
- `codeIntelligencePrompt.ts`：渲染检索来源、状态和截断信息。

## Task 1：实现安全 Exact Token 与 FTS5 检索

**Files:**

- Create: `src/extension/intelligence/retrieval/retrievalTypes.ts`
- Create: `src/extension/intelligence/retrieval/sqliteRetriever.ts`
- Create: `test/intelligence/sqliteRetriever.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [ ] **Step 1：写标识符、路径、转义和硬 limit 失败测试**

```ts
it("retrieves exact identifiers, paths, and qualified names", async () => {
  const retriever = createRetrieverWithCards([
    card("src/extension.ts", "LoopAgentChatViewProvider.startRun"),
    card("src/extension/intelligence/vscodeWorkspaceIntelligence.ts", "createVsCodeWorkspaceIntelligence"),
  ]);
  const hits = await retriever.searchText("extension.ts LoopAgentChatViewProvider.startRun", 1);
  expect(hits).toEqual([
    expect.objectContaining({ qualifiedName: "LoopAgentChatViewProvider.startRun" }),
  ]);
});

it("escapes FTS syntax and loads no more rows than limit", async () => {
  const retriever = createRetrieverWithManyCards(100);
  const hits = await retriever.searchText('workspace OR "unterminated *', 5);
  expect(hits.length).toBeLessThanOrEqual(5);
  expect(retriever.stats().loadedChunkRows).toBeLessThanOrEqual(5);
});
```

另测空查询和全符号查询返回空，不执行无界 `MATCH`。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteRetriever.test.ts
```

Expected: FAIL，retrieval 类型和 SQLite retriever 不存在。

- [ ] **Step 3：实现 DTO 和有界 store 查询**

```ts
export type RetrievalSource = "exact" | "fts" | "vector" | "graph";

export type RetrievalHit = {
  chunkId: string;
  nodeId?: string;
  filePath: string;
  qualifiedName?: string;
  chunkKind: CodeChunkKind;
  source: RetrievalSource;
  rank: number;
  score: number;
};

export type VectorCandidateSource = {
  search(query: string, limit: number): Promise<VectorCandidateResult>;
};

export type RetrievalDiagnostic = { code: string; message: string };

export type VectorCandidateResult = {
  hits: RetrievalHit[];
  diagnostics: RetrievalDiagnostic[];
};

export type RetrievedChunk = {
  chunkId: string;
  nodeId?: string;
  filePath: string;
  chunkKind: CodeChunkKind;
  sourceText: string;
  startLine?: number;
  endLine?: number;
  tokenHint: number;
};

export type RetrievalTrace = {
  sources: RetrievalSource[];
  candidateCounts: Partial<Record<RetrievalSource, number>>;
  truncatedBy: string[];
};

export type RetrievedCodeContext = {
  hits: RetrievalHit[];
  entryNodes: CodeNode[];
  relatedNodes: CodeNode[];
  edges: CodeEdge[];
  chunks: RetrievedChunk[];
  trace: RetrievalTrace;
  diagnostics: RetrievalDiagnostic[];
  truncated: boolean;
};
```

exact 和 FTS 都使用 `searchText.ts` 规范化 token。FTS expression 只由受控 token 生成，SQL 使用绑定参数；所有 store/RPC 方法强制正整数 limit。

- [ ] **Step 4：扩展 RPC 并确认 GREEN**

RPC 增加 `searchText` 和 `getChunks`，只返回扁平 DTO。运行：

```powershell
npm test -- test/intelligence/sqliteRetriever.test.ts test/intelligence/searchIndex.test.ts
npm run typecheck
```

Expected: 全部通过，旧 SearchIndex 测试继续作为拆词基线。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/retrieval/retrievalTypes.ts src/extension/intelligence/retrieval/sqliteRetriever.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteRetriever.test.ts
git diff --cached --check
git commit -m "feat(intelligence): retrieve persisted code chunks"
```

## Task 2：实现有界 SQL 图扩展

**Files:**

- Create: `src/extension/intelligence/retrieval/sqliteGraphQuery.ts`
- Create: `test/intelligence/sqliteGraphQuery.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [ ] **Step 1：写深度、node、edge 和循环失败测试**

```ts
it("expands only within graph budgets", async () => {
  const graph = createPersistedCallChain(20);
  const result = await graph.expand(["node:0"], { depth: 2, maxNodes: 5, maxEdges: 6 });
  expect(result.nodes.length).toBeLessThanOrEqual(5);
  expect(result.edges.length).toBeLessThanOrEqual(6);
  expect(result.nodes).toContainEqual(expect.objectContaining({ id: "node:2" }));
  expect(result.nodes).not.toContainEqual(expect.objectContaining({ id: "node:3" }));
});
```

另测 call cycle 去重、depth=0 只返回入口、任一预算非正数时拒绝请求。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteGraphQuery.test.ts
```

Expected: FAIL，SQL graph query 不存在。

- [ ] **Step 3：实现 recursive CTE 和固定预算**

```ts
export type GraphBudget = { depth: number; maxNodes: number; maxEdges: number };
export type RetrievedGraph = {
  nodes: CodeNode[];
  edges: CodeEdge[];
  truncated: boolean;
  truncatedBy: Array<"depth" | "nodes" | "edges">;
};
export function createSqliteGraphQuery(store: GraphStore): {
  expand(nodeIds: readonly string[], budget: GraphBudget): Promise<RetrievedGraph>;
};
```

使用 source/target 索引、有界 recursive CTE、visited node 去重。结果包含 `truncated` 和达到的具体 budget；禁止增加无预算 overload 或完整图 API。

- [ ] **Step 4：扩展 RPC 并确认 GREEN**

增加 `expandGraph` DTO，worker 只返回预算内 nodes/edges。运行：

```powershell
npm test -- test/intelligence/sqliteGraphQuery.test.ts test/intelligence/semanticGraph.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/retrieval/sqliteGraphQuery.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteGraphQuery.test.ts
git diff --cached --check
git commit -m "feat(intelligence): expand bounded sqlite code graph"
```

## Task 3：实现无向量依赖的基础 HybridRetriever

**Files:**

- Create: `src/extension/intelligence/retrieval/hybridRetriever.ts`
- Create: `test/intelligence/hybridRetriever.test.ts`
- Modify: `src/extension/intelligence/retrieval/retrievalTypes.ts`

- [ ] **Step 1：写基础 RRF、无 vector trace 和稳定排序失败测试**

```ts
it("fuses exact, FTS, and graph without a vector source", async () => {
  const result = await createHybridFixture({ vectorSource: undefined }).retrieve(
    "createConfiguredAgentRunner",
    focusedProfile(),
  );
  expect(result.hits[0]?.chunkId).toBe("chunk:providerRegistry");
  expect(result.trace.sources).toEqual(expect.arrayContaining(["exact", "fts", "graph"]));
  expect(result.trace.sources).not.toContain("vector");
});

it("breaks equal scores by stable chunk id", async () => {
  const result = await equalRankFixture().retrieve("runner", focusedProfile());
  expect(result.hits.map((hit) => hit.chunkId)).toEqual(["chunk:a", "chunk:b"]);
});
```

另测 graph/total context budget 和无命中 trace。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/hybridRetriever.test.ts
```

Expected: FAIL，HybridRetriever 不存在。

- [ ] **Step 3：实现基础融合和 optional interface**

```ts
export type HybridRetrieverDeps = {
  text: SqliteRetriever;
  graph: SqliteGraphQuery;
  vector?: VectorCandidateSource;
};

export type HybridRetriever = {
  retrieve(query: string, profile: CodeIntelligenceBudgetProfile): Promise<RetrievedCodeContext>;
};
```

使用 `k=60` RRF。没有 vector 时不调用、不计分、不写 trace。vector source 返回 diagnostics 但 hits 为空时只合并诊断，不把 `vector` 加入 `trace.sources`。node kind/path bonus 明确封顶，不能覆盖 exact rank 1。相同分数按 chunk ID。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/hybridRetriever.test.ts test/intelligence/sqliteRetriever.test.ts test/intelligence/sqliteGraphQuery.test.ts
npm run typecheck
```

Expected: 全部通过，vector 尚未实现也不需要 fake 生产代码。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/retrieval/hybridRetriever.ts src/extension/intelligence/retrieval/retrievalTypes.ts test/intelligence/hybridRetriever.test.ts
git diff --cached --check
git commit -m "feat(intelligence): add bounded hybrid retrieval"
```

## Task 4：把模型上下文入口迁移到 SQLite DTO

**Files:**

- Modify: `src/extension/intelligence/context/codeIntelligenceContext.ts`
- Modify: `src/extension/intelligence/context/codeIntelligencePrompt.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `test/intelligence/codeIntelligenceContext.test.ts`
- Modify: `test/intelligence/codeIntelligencePrompt.test.ts`
- Modify: `test/intelligence/workspaceIntelligence.test.ts`
- Modify: `test/providerRegistryCodeContext.test.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-retrieval-context-design.md`

- [ ] **Step 1：写 SQLite-only、pending timeout 和单例失败测试**

```ts
it("builds prompts from bounded retrieved chunks without full indexes", async () => {
  const retriever = fakeHybridRetriever(retrievedProviderContext());
  const intelligence = createWorkspaceIntelligence({ retriever, indexer: fakeReadyIndexer() });
  const prompt = await intelligence.buildCodeIntelligencePrompt("模型集成是怎么实现的");
  expect(prompt).toContain("providerRegistry.ts");
  expect(prompt).toContain("createConfiguredAgentRunner");
  expect(intelligence).not.toHaveProperty("graph");
  expect(intelligence).not.toHaveProperty("searchIndex");
});

it("uses the last committed index after the 2000ms wait budget", async () => {
  const intelligence = timeoutWorkspaceIntelligence(oldCommittedContext());
  const prompt = await intelligence.buildCodeIntelligencePrompt("explain startRun");
  expect(prompt).toContain("索引状态: partial");
});
```

provider test 断言多次请求复用扩展注入的同一个 WorkspaceIntelligence/worker。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/codeIntelligenceContext.test.ts test/intelligence/workspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts
```

Expected: FAIL，context 仍要求完整 graph/search/source provider。

- [ ] **Step 3：迁移 context 和 prompt 契约**

```ts
export function createCodeIntelligenceContext(options: {
  query: string;
  retrieved: RetrievedCodeContext;
  maxChars?: number;
}): CodeIntelligenceResult;
```

context 只排序、去重、裁剪和 fallback。`WorkspaceIntelligence` 只协调 indexer/retriever；查询等待 job 最多 2,000ms。prompt 增加真实 trace、chunk kind 统计、index generation 和 truncated，不输出数据库绝对路径。

- [ ] **Step 4：删除生产调用并运行阶段全量验证**

移除生产路径的 `createSemanticGraph`、`createSearchIndex`、`extractionCacheByFile` 和 source cache 使用；旧文件本身留到生命周期清理计划确认无消费者后删除。运行：

```powershell
npm test -- test/intelligence/sqliteRetriever.test.ts test/intelligence/sqliteGraphQuery.test.ts test/intelligence/hybridRetriever.test.ts test/intelligence/codeIntelligenceContext.test.ts test/intelligence/codeIntelligencePrompt.test.ts test/intelligence/workspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts
npm run typecheck
npm run compile
git diff --check
```

Expected: 全部通过；基础测试不配置 vector provider。

- [ ] **Step 5：更新规格状态并提交**

把检索规格状态改为“基础检索已实现，等待向量增强和总体验证”。提交：

```powershell
git add src/extension/intelligence/context/codeIntelligenceContext.ts src/extension/intelligence/context/codeIntelligencePrompt.ts src/extension/intelligence/workspaceIntelligence.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts src/extension/model/providerRegistry.ts test/intelligence/codeIntelligenceContext.test.ts test/intelligence/codeIntelligencePrompt.test.ts test/intelligence/workspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts docs/superpowers/specs/2026-07-11-sqlite-index-retrieval-context-design.md
git diff --cached --check
git commit -m "feat(intelligence): build context from sqlite retrieval"
```

## 计划完成记录

记录 exact/FTS/graph 查询行数和预算、无 vector trace 测试、2000ms timeout 行为、生产内存索引调用清单、提交、偏差和技术债。完成 Task 1-4 后才能进入 embedding/vector 计划。
