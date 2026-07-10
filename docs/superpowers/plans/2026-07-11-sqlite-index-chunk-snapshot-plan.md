# 稳定 Chunk 与 Snapshot 差异实施计划

> **Agent 执行要求：** 在既有 SQLite feature worktree 中执行，选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。逐任务执行复选框，严格 RED -> GREEN -> REFACTOR。

**目标：** 把单文件 AST 抽取转换为稳定、可序列化的 `ExtractionSnapshot`，并在事务内精确应用七类 chunk 差异。

**架构：** Extension Host 在一次解析生命周期内完成稳定 ID、card/source chunk 和 hash；worker 读取旧 snapshot、计算纯函数 diff，并用单文件事务维护事实、FTS 和 embedding 映射。

**技术栈：** TypeScript、web-tree-sitter、Node crypto、SQLite、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-chunk-snapshot-design.md`

**前置门禁：** `2026-07-11-sqlite-index-storage-worker-plan.md` 全部完成，schema、worker RPC、job 和 writer lease 测试通过。

---

## 文件职责

- `stableIdentity.ts`：文件、节点、边和 chunk 的稳定语义键与 SHA-256 ID。
- `extractionSnapshot.ts`：把现有 `ExtractionResult` 重写为可持久化 snapshot。
- `chunkTypes.ts`：chunk DTO 和 kind。
- `searchText.ts`：确定性标识符、qualified name 和路径拆词。
- `codeChunker.ts`：card chunk 总协调。
- `sourceBodyChunker.ts`：AST source body 子块和 overlap。
- `snapshotDiff.ts`：七类纯函数差异和精确写入集合。

## Task 1：建立稳定身份和 Snapshot Core

**Files:**

- Create: `src/extension/intelligence/indexing/stableIdentity.ts`
- Create: `src/extension/intelligence/indexing/extractionSnapshot.ts`
- Create: `test/intelligence/extractionSnapshot.test.ts`
- Modify: `src/extension/intelligence/storage/indexTypes.ts`

- [ ] **Step 1：写范围移动和 overload 失败测试**

```ts
it("keeps node and edge identities stable when ranges move", () => {
  const first = buildExtractionSnapshot(snapshotInput({ functionStartLine: 5, callLine: 6 }));
  const moved = buildExtractionSnapshot(snapshotInput({ functionStartLine: 25, callLine: 26 }));
  expect(moved.nodes[0]?.id).toBe(first.nodes[0]?.id);
  expect(moved.nodes[0]?.semanticKey).toBe(first.nodes[0]?.semanticKey);
  expect(moved.edges[0]?.sourceNodeId).toBe(first.edges[0]?.sourceNodeId);
  expect(moved.nodes[0]?.startLine).toBe(25);
});

it("distinguishes overloads by normalized signature", () => {
  expect(createSymbolSemanticKey(functionNode("run", "run(value: string): void"))).not.toBe(
    createSymbolSemanticKey(functionNode("run", "run(value: number): void")),
  );
});
```

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/extractionSnapshot.test.ts
```

Expected: FAIL，稳定身份和 snapshot builder 不存在。

- [ ] **Step 3：实现稳定身份和引用重写**

```ts
export function createFileId(fileUri: string): string;
export function createSymbolSemanticKey(node: CodeNode, parentKey?: string): string;
export function createStableNodeId(fileId: string, semanticKey: string): string;
```

所有 ID 使用 UTF-8 SHA-256 hex，不包含 range、mtime 或时间。`buildExtractionSnapshot` 先建立旧 node ID -> stable ID map，再重写 edge、binding 和 unresolved reference；不释放 `parsed.tree`。本任务的 snapshot core 暂不包含 `chunks`，保证中间提交独立 typecheck。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/extractionSnapshot.test.ts test/intelligence/typescriptAdapter.test.ts test/intelligence/pythonAdapter.test.ts
npm run typecheck
```

Expected: 全部通过，现有 adapter DTO 行为不变。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/stableIdentity.ts src/extension/intelligence/indexing/extractionSnapshot.ts src/extension/intelligence/storage/indexTypes.ts test/intelligence/extractionSnapshot.test.ts
git diff --cached --check
git commit -m "feat(intelligence): create stable extraction snapshots"
```

## Task 2：生成稳定 Card Chunks 和三层 Hash

**Files:**

- Create: `src/extension/intelligence/chunking/chunkTypes.ts`
- Create: `src/extension/intelligence/chunking/codeChunker.ts`
- Create: `src/extension/intelligence/chunking/searchText.ts`
- Create: `test/intelligence/codeChunker.test.ts`
- Modify: `src/extension/intelligence/indexing/stableIdentity.ts`
- Modify: `src/extension/intelligence/indexing/extractionSnapshot.ts`

- [ ] **Step 1：写 card、ID、拆词和 hash 失败测试**

```ts
it("builds stable cards without volatile ranges", () => {
  const chunks = createCodeChunks(snapshotFixture("src/extension/model/providerRegistry.ts"));
  const symbol = chunks.find((chunk) => chunk.chunkKind === "symbol_card");
  expect(symbol).toMatchObject({
    semanticKey: expect.stringContaining("createConfiguredAgentRunner"),
    sourceHash: expect.any(String),
    searchHash: expect.any(String),
    embeddingHash: expect.any(String),
  });
  expect(symbol?.searchText).toContain("create configured agent runner");
  expect(symbol?.embeddingText).not.toMatch(/42-96|sourceRange/);
});

it("keeps card ids stable when only ranges move", () => {
  const before = createCodeChunks(snapshotFixture("src/a.ts", { startLine: 5 }));
  const moved = createCodeChunks(snapshotFixture("src/a.ts", { startLine: 50 }));
  expect(moved.map((chunk) => chunk.id)).toEqual(before.map((chunk) => chunk.id));
});
```

测试分别断言 `file_card`、`symbol_card`、`class_card`、`test_case_card` 的关键字段。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/codeChunker.test.ts
```

Expected: FAIL，chunk 类型、search text 和 chunker 不存在。

- [ ] **Step 3：实现 DTO、拆词和 card 生成**

`chunkTypes.ts` 定义：

```ts
export type CodeChunkKind =
  | "file_card"
  | "symbol_card"
  | "class_card"
  | "callsite_card"
  | "test_case_card"
  | "source_body";

export type CodeChunk = {
  id: string;
  fileId: string;
  nodeId?: string;
  semanticKey: string;
  chunkKind: CodeChunkKind;
  sourceText: string;
  searchText: string;
  embeddingText: string;
  sourceHash: string;
  searchHash: string;
  embeddingHash: string;
  startLine?: number;
  endLine?: number;
  tokenHint: number;
};
```

`searchText.ts` 迁移当前 `searchIndex.ts` 的 camelCase、snake_case、kebab-case、qualified name、路径拆词为纯函数；字段排序固定。

在 `CodeChunkKind` 定义后再给 `stableIdentity.ts` 增加：

```ts
export function createStableChunkId(
  fileId: string,
  chunkKind: CodeChunkKind,
  semanticKey: string,
): string;
```

`createCodeChunks(snapshotCore)` 生成 file/symbol/class/test card，并分别从 `sourceText`、`searchText`、`embeddingText` 计算 SHA-256。Task 2 不生成 callsite/source body。

- [ ] **Step 4：加入 snapshot chunks 并确认 GREEN**

给 `ExtractionSnapshot` 增加 `chunks: CodeChunk[]`，在稳定节点映射后调用 card chunker。运行：

```powershell
npm test -- test/intelligence/codeChunker.test.ts test/intelligence/searchIndex.test.ts test/intelligence/extractionSnapshot.test.ts
npm run typecheck
```

Expected: 全部通过，旧 SearchIndex 测试只作为拆词基线。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/chunking/chunkTypes.ts src/extension/intelligence/chunking/codeChunker.ts src/extension/intelligence/chunking/searchText.ts src/extension/intelligence/indexing/stableIdentity.ts src/extension/intelligence/indexing/extractionSnapshot.ts test/intelligence/codeChunker.test.ts
git diff --cached --check
git commit -m "feat(intelligence): generate stable code cards"
```

## Task 3：生成 Source Body、Callsite 和超大函数子块

**Files:**

- Create: `src/extension/intelligence/chunking/sourceBodyChunker.ts`
- Create: `test/intelligence/sourceBodyChunker.test.ts`
- Modify: `src/extension/intelligence/chunking/codeChunker.ts`
- Modify: `src/extension/intelligence/indexing/extractionSnapshot.ts`
- Modify: `test/intelligence/codeChunker.test.ts`

- [ ] **Step 1：写边界、稳定子块和 tree 生命周期失败测试**

```ts
it("keeps a small function as one source body", () => {
  const chunks = createSourceBodyChunks(parsedFunction({ lines: 40, characters: 1_200 }));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.sourceText).toContain("function run");
});

it("splits an oversized function at named AST statement boundaries", () => {
  const chunks = createSourceBodyChunks(parsedFunction({ lines: 180, characters: 8_000 }));
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.sourceText.length <= 5_000)).toBe(true);
});

it("does not include line overlap in embedding text", () => {
  const [chunk] = createSourceBodyChunks(parsedFunction({ lines: 180, characters: 8_000 }));
  expect(chunk.sourceText.length).toBeGreaterThan(chunk.embeddingText.length);
});
```

另测前置空行移动不改变子块 ID，integration fixture 的 tree 最终只 delete 一次。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sourceBodyChunker.test.ts
```

Expected: FAIL，source body chunker 不存在。

- [ ] **Step 3：实现固定 AST 切块规则**

- 小函数：最多 120 行且最多 4,000 字符。
- 超大函数：优先按 `if/for/while/try/switch/callback/object literal` named range。
- 子块目标 1,500-3,000 字符，硬上限 5,000。
- overlap 前后最多 8 行，只进入 source text。
- semantic key 使用父符号键、node type、规范化首语句 hash，ordinal 仅解冲突。

callsite 只识别通用 AST 模式，不加入项目业务词表。

- [ ] **Step 4：在 tree 释放前接入并确认 GREEN**

把签名扩展为 `createCodeChunks(snapshotCore, parsed)`，保证 source 切块在 `parsed.tree?.delete()` 前完成，snapshot 不保存 tree。运行：

```powershell
npm test -- test/intelligence/sourceBodyChunker.test.ts test/intelligence/codeChunker.test.ts test/intelligence/workspaceAstIntegration.test.ts
npm run typecheck
```

Expected: 全部通过，tree delete 一次。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/chunking/sourceBodyChunker.ts src/extension/intelligence/chunking/codeChunker.ts src/extension/intelligence/indexing/extractionSnapshot.ts test/intelligence/sourceBodyChunker.test.ts test/intelligence/codeChunker.test.ts
git diff --cached --check
git commit -m "feat(intelligence): split source bodies by ast boundaries"
```

## Task 4：实现七类纯函数 Snapshot Diff

**Files:**

- Create: `src/extension/intelligence/indexing/snapshotDiff.ts`
- Create: `test/intelligence/snapshotDiff.test.ts`
- Modify: `src/extension/intelligence/storage/indexTypes.ts`

- [ ] **Step 1：写七类差异和精确操作失败测试**

```ts
it.each([
  ["unchanged", unchangedPair(), { chunkWrites: 0, ftsWrites: 0, embeddingWrites: 0 }],
  ["metadata-only", rangeOnlyPair(), { chunkWrites: 1, ftsWrites: 0, embeddingWrites: 0 }],
  ["source-changed", sourceOnlyPair(), { chunkWrites: 1, ftsWrites: 0, embeddingWrites: 0 }],
  ["search-changed", searchChangedPair(), { chunkWrites: 1, ftsWrites: 1, embeddingWrites: 0 }],
  ["embedding-changed", embeddingChangedPair(), { chunkWrites: 1, ftsWrites: 0, embeddingWrites: 1 }],
])("classifies %s and emits exact operations", (kind, [stored, incoming], counts) => {
  const diff = diffChunk(stored, incoming);
  expect(diff.kind).toBe(kind);
  expect(operationCounts(diff)).toEqual(counts);
});
```

另测 added/removed stable IDs、数组排序和“source/search/embedding 同时变化时取最高影响级别”。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/snapshotDiff.test.ts
```

Expected: FAIL，diff API 不存在。

- [ ] **Step 3：实现类型和优先级**

```ts
export type ChunkDiffKind =
  | "unchanged"
  | "metadata-only"
  | "source-changed"
  | "search-changed"
  | "embedding-changed";

export function diffChunk(stored: StoredChunk, incoming: CodeChunk): ChunkDiff;
export function diffExtractionSnapshot(stored: StoredFileSnapshot, incoming: ExtractionSnapshot): SnapshotChangeSet;
```

分类顺序固定为 embedding hash -> search hash -> source hash -> metadata。change set 分别列出 node、edge、binding、reference、diagnostic、chunk、FTS 和 embedding 操作，并按 stable ID 排序。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/snapshotDiff.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/snapshotDiff.ts src/extension/intelligence/storage/indexTypes.ts test/intelligence/snapshotDiff.test.ts
git diff --cached --check
git commit -m "feat(intelligence): diff stable code snapshots"
```

## Task 5：事务应用 Snapshot 差异并维护 FTS

**Files:**

- Create: `test/intelligence/sqliteSnapshotStore.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-chunk-snapshot-design.md`

- [ ] **Step 1：写局部更新、陈旧出边、孤立 FTS 和回滚失败测试**

```ts
it("keeps unchanged chunks and removes stale owned edges", () => {
  const store = createTestStore({ now: sequence(100, 200) });
  store.applyFileSnapshot(initialTwoFunctionSnapshot());
  const before = store.readStoredFileSnapshot("file:src/a.ts");
  store.applyFileSnapshot(snapshotWithSecondFunctionAndCallChanged());
  const after = store.readStoredFileSnapshot("file:src/a.ts");
  expect(after.chunks[0]?.updatedAt).toBe(before.chunks[0]?.updatedAt);
  expect(after.edges.map((edge) => edge.id)).not.toContain("edge:removed-call");
});

it("rolls back the whole file update on a constraint failure", () => {
  const store = createStoreWithInitialSnapshot();
  expect(() => store.applyFileSnapshot(snapshotWithMissingEdgeTarget())).toThrow();
  expect(store.readStoredFileSnapshot("file:src/a.ts").file.contentHash).toBe("initial");
});
```

另测 source-only 不写 FTS/embedding，range-only 不改变 chunk `updated_at`，删除后 `chunk_fts` 无孤立行。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteSnapshotStore.test.ts
```

Expected: FAIL，store 尚不能应用 snapshot。

- [ ] **Step 3：实现单文件事务顺序**

按设计规格的九步顺序：读旧 snapshot、diff、删 removed FTS/facts、删变化 owner 陈旧事实、upsert facts、精确 chunk/FTS、embedding pending、file ready、commit。所有写事务先验证 writer lease。

RPC 增加：

```ts
| { id: number; kind: "applyFileSnapshot"; snapshot: ExtractionSnapshot }
| { id: number; kind: "removeFile"; fileUri: string }
```

只返回写入统计，不返回完整数据库 snapshot：

```ts
export type SnapshotWriteStats = {
  inserted: number;
  updated: number;
  removed: number;
  ftsWrites: number;
  embeddingsInvalidated: number;
};
```

- [ ] **Step 4：运行阶段全量验证**

```powershell
npm test -- test/intelligence/extractionSnapshot.test.ts test/intelligence/codeChunker.test.ts test/intelligence/sourceBodyChunker.test.ts test/intelligence/snapshotDiff.test.ts test/intelligence/sqliteSnapshotStore.test.ts test/intelligence/workspaceAstIntegration.test.ts
npm run typecheck
npm run compile
git diff --check
```

Expected: 全部通过；旧出边/FTS 被删除；失败事务保留旧版本。

- [ ] **Step 5：更新规格状态并提交**

把 chunk/snapshot 规格状态改为“已实现，等待总体验证”，记录实际偏差。提交：

```powershell
git add src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteSnapshotStore.test.ts docs/superpowers/specs/2026-07-11-sqlite-index-chunk-snapshot-design.md
git diff --cached --check
git commit -m "feat(intelligence): persist chunk snapshot diffs"
```

## 计划完成记录

记录实际提交、七类 diff 操作计数、事务回滚结果、tree 生命周期结果、偏差和技术债。Task 1-5 全部完成后才能进入 workspace 增量计划。
