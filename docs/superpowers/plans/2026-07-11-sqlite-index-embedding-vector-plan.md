# Embedding 与向量召回实施计划

> **Agent 执行要求：** 在既有 SQLite feature worktree 中执行，选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。逐任务 RED -> GREEN -> REFACTOR。

**目标：** 为稳定 card chunk 增加可配置、内容寻址的 embedding 生命周期和 worker 内有界向量召回，同时保持无 provider 的基础检索不变。

**架构：** Extension Host coordinator 执行远程 HTTP，SQLite worker 持久化 cache/mapping 并批量计算余弦 top-k。向量通过检索阶段已有 `VectorCandidateSource` 注入。

**技术栈：** TypeScript、SecretStorage、Fetch API、SQLite BLOB、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-embedding-vector-design.md`

**前置门禁：** 检索与上下文计划完成；无 vector provider 的 exact/FTS/graph 测试全绿。

---

## 文件职责

- `embeddingProvider.ts`：provider-neutral interface。
- `embeddingCoordinator.ts`：pending claim、hash 去重、批量远程调用、结果提交和 retry。
- `vectorIndex.ts`：worker store adapter、有界余弦扫描、query source adapter。
- `embeddingConfig.ts`：workspace config + SecretStorage 解析。
- `openAiCompatibleEmbeddingProvider.ts`：安全 HTTP 请求和响应校验。

## Task 1：实现内容寻址 Embedding Coordinator

**Files:**

- Create: `src/extension/intelligence/embedding/embeddingProvider.ts`
- Create: `src/extension/intelligence/embedding/embeddingCoordinator.ts`
- Create: `test/intelligence/embeddingCoordinator.test.ts`
- Modify: `src/extension/intelligence/storage/indexTypes.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [ ] **Step 1：写 hash 去重、复用、模型切换和 lease 失败测试**

```ts
it("embeds each pending content hash once and binds all matching chunks", async () => {
  const provider = fakeEmbeddingProvider();
  const coordinator = createEmbeddingCoordinator({
    store: storeWithDuplicatePendingHashes(),
    provider,
  });
  await coordinator.runBatch();
  expect(provider.embed).toHaveBeenCalledWith([expect.any(String)], expect.anything());
  expect(provider.embed.mock.calls[0]?.[0]).toHaveLength(1);
  expect(coordinator.stats().boundChunks).toBe(2);
});

it("does not commit a completed request after losing the writer lease", async () => {
  const fixture = deferredProviderFixture();
  const running = fixture.coordinator.runBatch();
  fixture.store.loseLease();
  fixture.provider.resolve([[0.1, 0.2]]);
  await running;
  expect(fixture.store.commitEmbeddingBatch).not.toHaveBeenCalled();
});
```

另测未变化 ready mapping 不改 timestamp；模型变化只创建新模型 pending，不写 snapshot；失败增加 attempts/lastError。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/embeddingCoordinator.test.ts
```

Expected: FAIL，provider/coordinator/RPC 不存在。

- [ ] **Step 3：实现 provider-neutral coordinator**

```ts
export type EmbeddingProvider = {
  readonly id: string;
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
};

export type EmbeddingCoordinator = {
  reconcileModel(): Promise<void>;
  runBatch(): Promise<EmbeddingBatchStats>;
  dispose(): Promise<void>;
};

export type EmbeddingBatchStats = {
  claimedChunks: number;
  uniqueHashes: number;
  cacheWrites: number;
  boundChunks: number;
  failedHashes: number;
};
```

每批有明确 limit，按 `(provider, model, embeddingHash)` 去重。远程调用不在 worker 中；提交 RPC 在事务内重新验证 writer lease，先 upsert cache 再绑定 chunks。dispose abort 当前 provider request。

- [ ] **Step 4：实现 store/RPC 并确认 GREEN**

增加 `claimPendingEmbeddings`、`commitEmbeddingBatch`、`failEmbeddingBatch`、`reconcileEmbeddingModel` DTO。mapping hash 变化由 snapshot 事务置 pending；旧 cache 不删除。运行：

```powershell
npm test -- test/intelligence/embeddingCoordinator.test.ts test/intelligence/sqliteSnapshotStore.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/embedding/embeddingProvider.ts src/extension/intelligence/embedding/embeddingCoordinator.ts src/extension/intelligence/storage/indexTypes.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/embeddingCoordinator.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist content addressed embeddings"
```

## Task 2：实现 Worker 内有界向量扫描

**Files:**

- Create: `src/extension/intelligence/retrieval/vectorIndex.ts`
- Create: `test/intelligence/vectorIndex.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [ ] **Step 1：写 Float32、批量 top-k、上限和损坏 blob 失败测试**

```ts
it("scans vectors in bounded batches and maintains top k", async () => {
  const index = createVectorIndex(storeWithEmbeddings(1_000), {
    batchSize: 256,
    maxCards: 20_000,
  });
  const result = await index.search(queryVector(), 10);
  expect(result.hits).toHaveLength(10);
  expect(index.stats().maxLoadedAtOnce).toBeLessThanOrEqual(256);
});

it("skips scanning when card count exceeds the hard limit", async () => {
  const result = await createVectorIndex(storeWithEmbeddings(20_001)).search(queryVector(), 10);
  expect(result).toEqual(expect.objectContaining({ skippedReason: "card_limit_exceeded" }));
});
```

另测 Float32 round-trip、blob length/dim 不一致跳过、NaN/Infinity 聚合诊断、source_body 默认不扫描。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/vectorIndex.test.ts
```

Expected: FAIL，VectorIndex 不存在。

- [ ] **Step 3：实现 worker-only vector store**

```ts
export type VectorSearchOptions = { limit: number; batchSize: number; maxCards: number };
export type VectorSearchResult = {
  hits: RetrievalHit[];
  skippedReason?: "card_limit_exceeded";
  diagnostics: RetrievalDiagnostic[];
};
export function encodeFloat32Vector(vector: readonly number[]): Buffer;
export function decodeFloat32Vector(blob: Uint8Array, dim: number): Float32Array;
```

worker 每批最多 256 row，维护 limit 大小的稳定 top-k。RPC 请求包含 provider/model/queryVector/limit，统一返回 `VectorSearchResult`，不返回 vector。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/vectorIndex.test.ts
npm run typecheck
```

Expected: 全部通过，统计证明最大同时加载 256。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/retrieval/vectorIndex.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/vectorIndex.test.ts
git diff --cached --check
git commit -m "feat(intelligence): scan bounded sqlite vectors"
```

## Task 3：实现安全的 OpenAI-Compatible Provider 配置

**Files:**

- Create: `src/extension/intelligence/embedding/embeddingConfig.ts`
- Create: `src/extension/intelligence/embedding/openAiCompatibleEmbeddingProvider.ts`
- Create: `test/intelligence/embeddingConfig.test.ts`
- Create: `test/intelligence/openAiCompatibleEmbeddingProvider.test.ts`
- Modify: `package.json`
- Modify: `test/packageManifest.test.ts`

- [ ] **Step 1：写 disabled、SecretStorage、协议和泄密失败测试**

```ts
it("keeps embeddings disabled until config and secret are complete", async () => {
  const config = await getEmbeddingRuntimeConfig(fakeContext(), fakeWorkspaceConfig({ enabled: false }));
  expect(config).toEqual({ enabled: false });
});

it("posts an ordered OpenAI-compatible batch", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({
    data: [
      { index: 0, embedding: [0.1, 0.2] },
      { index: 1, embedding: [0.3, 0.4] },
    ],
  }));
  const provider = createOpenAiCompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example/v1",
    apiKey: "secret-key",
    model: "embedding-model",
    fetchImpl,
  });
  await expect(provider.embed(["a", "b"])).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
});
```

另测 HTTP 非 2xx、非 JSON、data 缺失、index 不连续、维度不一致、非有限数值、abort；错误不包含 `secret-key` 或 Authorization。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts
```

Expected: FAIL，配置和 provider 不存在。

- [ ] **Step 3：增加显式配置并实现 provider**

manifest properties：

```json
"loopagent.codeIndex.embedding.enabled": { "type": "boolean", "default": false },
"loopagent.codeIndex.embedding.baseUrl": { "type": "string", "default": "" },
"loopagent.codeIndex.embedding.model": { "type": "string", "default": "" }
```

key 只读取 `SecretStorage` 的 `loopagent.codeIndex.embedding.apiKey`。base URL 规范化后请求 `/embeddings`；timeout/abort 透传。验证 data 数量、index、维度和 finite number。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts test/packageManifest.test.ts
npm run typecheck
```

Expected: 全部通过，日志和错误无 key。

- [ ] **Step 5：提交**

```powershell
git add package.json src/extension/intelligence/embedding/embeddingConfig.ts src/extension/intelligence/embedding/openAiCompatibleEmbeddingProvider.ts test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts test/packageManifest.test.ts
git diff --cached --check
git commit -m "feat(intelligence): configure code embedding provider"
```

## Task 4：注入 VectorCandidateSource 并保持基础检索退化

**Files:**

- Modify: `src/extension/intelligence/retrieval/vectorIndex.ts`
- Modify: `src/extension/intelligence/retrieval/hybridRetriever.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/intelligence/hybridRetriever.test.ts`
- Modify: `test/intelligence/workspaceIntelligence.test.ts`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-embedding-vector-design.md`

- [ ] **Step 1：写真实 vector 融合、disabled 和失败退化测试**

```ts
it("adds real vector ranks without overriding a strong exact hit", async () => {
  const result = await createHybridFixture({ vectorSource: fakeVectorSource() }).retrieve(
    "assistantDelta",
    focusedProfile(),
  );
  expect(result.hits[0]?.chunkId).toBe("chunk:assistantDelta");
  expect(result.trace.sources).toContain("vector");
});

it.each([undefined, failingVectorSource(), skippedVectorSource()])(
  "keeps exact FTS and graph usable when vector is unavailable",
  async (vectorSource) => {
    const result = await createHybridFixture({ vectorSource }).retrieve("startRun", focusedProfile());
    expect(result.hits.length).toBeGreaterThan(0);
  },
);
```

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/hybridRetriever.test.ts test/intelligence/workspaceIntelligence.test.ts
```

Expected: FAIL，vector adapter 尚未注入。

- [ ] **Step 3：实现 query embedding adapter 和可选 wiring**

`VectorCandidateSource.search(query, limit)` 先通过 provider embed 单条 query，再调用 worker vector RPC，并把 `VectorSearchResult` 映射为 `{ hits, diagnostics }`。`createVsCodeWorkspaceIntelligence` 接受以下可选依赖：

```ts
export type EmbeddingRuntime = {
  coordinator: EmbeddingCoordinator;
  vectorSource: VectorCandidateSource;
  dispose(): Promise<void>;
};

export type EmbeddingRuntimeFactory = {
  create(): Promise<EmbeddingRuntime | undefined>;
};
```

只有依赖方提供完整 enabled config 才创建 runtime，否则返回 `undefined`。ExtensionContext、SecretStorage 和实际配置的注入由下一份生命周期计划完成。vector error/skipped 转 diagnostic，不抛断基础 retrieve。

- [ ] **Step 4：运行阶段全量验证**

```powershell
npm test -- test/intelligence/embeddingCoordinator.test.ts test/intelligence/vectorIndex.test.ts test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts test/intelligence/hybridRetriever.test.ts test/intelligence/workspaceIntelligence.test.ts test/intelligence/sqliteRetriever.test.ts test/intelligence/sqliteGraphQuery.test.ts
npm run typecheck
npm run compile
git diff --check
```

Expected: 全部通过；未配置 provider 的基础检索测试保持不变。

- [ ] **Step 5：更新规格状态并提交**

把 embedding 规格状态改为“已实现，等待真实模型和总体验证”。提交：

```powershell
git add src/extension/intelligence/retrieval/vectorIndex.ts src/extension/intelligence/retrieval/hybridRetriever.ts src/extension/intelligence/workspaceIntelligence.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/hybridRetriever.test.ts test/intelligence/workspaceIntelligence.test.ts docs/superpowers/specs/2026-07-11-sqlite-index-embedding-vector-design.md
git diff --cached --check
git commit -m "feat(intelligence): add optional vector retrieval"
```

## 计划完成记录

记录 provider/model、batch/count（不记录 key/text）、cache 复用率、max loaded vectors、card limit 退化、RRF 结果、提交、偏差和技术债。完成 Task 1-4 后才能进入生命周期与总体验证计划。
