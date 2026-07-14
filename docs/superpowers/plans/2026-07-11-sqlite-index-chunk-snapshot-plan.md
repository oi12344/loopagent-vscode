# 稳定 Chunk 与 Snapshot 最小实施计划

> **Agent 执行要求：** 在 SQLite feature worktree 中执行；按 RED -> GREEN -> REFACTOR 完成一个可查询的纵向切片。

**目标：** 将单文件 AST 抽取持久化为稳定的 `file_card` 与 `symbol_card`，并在 SQLite FTS 中可查询。

**架构：** Extension Host 从 `ExtractionSnapshot` 生成两个稳定 card；SQLite worker 在 writer lease 保护的单文件事务内替换陈旧事实、写入 card，并只在 `searchHash` 变化时重建对应 FTS 行。实现直接比较 hash，不建立独立 diff 框架。

**技术栈：** TypeScript、web-tree-sitter、Node crypto、SQLite、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-chunk-snapshot-design.md`

**前置门禁：** SQLite storage worker 的 schema、worker RPC、job 与 writer lease 测试通过。

---

## 范围

- 本轮只生成 `file_card` 与 `symbol_card`；类、测试、调用点和源码正文不生成独立 card。
- 保留 `sourceHash`、`searchHash`、`embeddingHash`，但未配置 embedding 模型时不创建 `chunk_embeddings` 映射。
- 复用一套标识符和路径拆词函数给内存 `SearchIndex` 与 card 搜索文本使用。
- `applyFileSnapshot` 直接在事务内比较 hash 并维护 FTS；不引入 `SnapshotChangeSet`、七类 diff 类型或生产写入统计 DTO。

## 文件职责

- `stableIdentity.ts`：文件、节点、关系和 chunk 的稳定语义键与 SHA-256 ID。
- `extractionSnapshot.ts`：将 `ExtractionResult` 改写为可持久化 snapshot，并附加最小 card。
- `chunking/chunkTypes.ts`：当前两个 card 的 DTO。
- `chunking/searchText.ts`：共享的标识符、qualified name 与路径拆词。
- `chunking/codeChunker.ts`：生成 file/symbol card 及三层 hash。
- `sqliteIndexStore.ts`：在单文件事务中应用 snapshot 并维护 FTS。

## Task 1：建立稳定身份和 Snapshot Core（已完成）

已合入 `638c7a4`、`60a8ca4`、`4f8eefa`、`83a841b`、`b88a5ae`。实现 UTF-8 SHA-256 稳定身份、路径规范化、overload/重复节点与关系消歧、稳定引用重写，并保持 tree 的释放责任在调用方。

## Task 2：生成并持久化最小 Card Snapshot

**Files:**

- Create: `src/extension/intelligence/chunking/chunkTypes.ts`
- Create: `src/extension/intelligence/chunking/searchText.ts`
- Create: `src/extension/intelligence/chunking/codeChunker.ts`
- Create: `test/intelligence/codeChunker.test.ts`
- Create: `test/intelligence/sqliteSnapshotStore.test.ts`
- Modify: `src/extension/intelligence/graph/searchIndex.ts`
- Modify: `src/extension/intelligence/indexing/stableIdentity.ts`
- Modify: `src/extension/intelligence/indexing/extractionSnapshot.ts`
- Modify: `src/extension/intelligence/storage/indexTypes.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [x] **Step 1：写 card 与持久化闭环的失败测试**

```ts
it("persists stable file and symbol cards and rewrites only changed FTS rows", () => {
  const first = buildExtractionSnapshot(snapshotFixture({ functionStartLine: 5 }));
  const moved = buildExtractionSnapshot(snapshotFixture({ functionStartLine: 25 }));

  store.applyFileSnapshot(ownerId, first);
  const before = readChunkRows(database);
  const ftsBefore = readFtsRows(database);
  store.applyFileSnapshot(ownerId, moved);
  const after = readChunkRows(database);

  expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  expect(readFtsRows(database)).toEqual(ftsBefore);
});

it("removes stale facts and rolls back the file when a constraint fails", () => {
  store.applyFileSnapshot(ownerId, initialSnapshot());
  expect(() => store.applyFileSnapshot(ownerId, invalidSnapshot())).toThrow();
  expect(readFileHash(database)).toBe(initialSnapshot().file.contentHash);
});
```

另测 `file_card` 与 `symbol_card` 的稳定 ID、三层 hash、shared tokenization，以及删除符号后不残留 edge/FTS 行。

- [x] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/codeChunker.test.ts test/intelligence/sqliteSnapshotStore.test.ts
```

Expected: FAIL，chunker 和 snapshot write API 不存在。

- [x] **Step 3：实现最小 card、共享拆词与直接事务写入**

```ts
export type CodeChunkKind = "file_card" | "symbol_card";

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
};

export function createStableChunkId(fileId: string, kind: CodeChunkKind, semanticKey: string): string;
export function createSearchTokens(value: string): string[];
```

`searchIndex.ts` 改用 `createSearchTokens`，不保留第二套 camelCase/snake_case/path 拆词。`createCodeChunks` 只产出每文件一个 `file_card` 与每个非 file 的 snapshot node 一个 `symbol_card`；不读取整文件源码、不猜测测试语义、不创建 class/callsite/source-body card。

`applyFileSnapshot(ownerId, snapshot): void` 在一个已有 lease 的事务内完成：删除已不存在的 file-owned chunk 与事实、删除变化 owner 的陈旧 edge/binding/reference/diagnostic、upsert 新事实与 chunk。三个 hash 未变的 card 只更新 range，不改 `updated_at`；仅对 `searchHash` 改变的 card 重写 FTS，最后更新 file 状态。`embeddingHash` 仅持久化在 chunk，embedding 映射由后续 embedding 任务创建。任何 SQL 失败回滚整个文件。

- [x] **Step 4：运行整体 GREEN 验证**

```powershell
npm test -- test/intelligence/codeChunker.test.ts test/intelligence/sqliteSnapshotStore.test.ts test/intelligence/searchIndex.test.ts test/intelligence/extractionSnapshot.test.ts test/intelligence/workspaceAstIntegration.test.ts
npm run typecheck
npm run compile
git diff --check
```

Expected: card 可稳定生成并写入 FTS；行号移动不重写搜索行；陈旧事实被删除；约束失败保留旧 snapshot。

- [x] **Step 5：更新规格状态并提交**

把规格状态改为“最小 card snapshot 已实现，等待工作区增量接入”，记录实际测试统计和偏差。提交：

```powershell
git add src/extension/intelligence/chunking src/extension/intelligence/graph/searchIndex.ts src/extension/intelligence/indexing src/extension/intelligence/storage test/intelligence/codeChunker.test.ts test/intelligence/sqliteSnapshotStore.test.ts docs/superpowers/specs/2026-07-11-sqlite-index-chunk-snapshot-design.md docs/superpowers/plans/2026-07-11-sqlite-index-chunk-snapshot-plan.md
git diff --cached --check
git commit -m "feat(intelligence): persist stable code cards"
```

**Task 2 完成记录（2026-07-14）：** 已生成稳定 `file_card` 与非 file node 的 `symbol_card`，并复用同一拆词函数给内存 SearchIndex 和 FTS card。SQLite store 在 writer lease 事务中清理陈旧事实、保留 hash 未变 card 的 `updated_at`、仅在 `searchHash` 改变时重写 FTS；worker RPC 仅暴露固定 snapshot DTO。RED 确认缺失 chunks 与写入 API；最终 `npm test` 为 48 个测试文件、256 个用例通过，`npm run typecheck`、`npm run compile` 与 `git diff --check` 退出 0。未创建 embedding mapping，也未实现延期 card 或复杂源码切分。

## 后续加固（不属于当前实施门禁）

- 当真实代码问答证明 card 缺少必要源码时，再增加 `source_body`；首版按固定文本上限切分，不实现 AST 语句分类、首语句 hash 或 overlap 策略。
- 当 language adapter 显式提供测试、继承或调用点事实，且检索评估显示 symbol card 不足时，再增加 `test_case_card`、`class_card` 或 `callsite_card`。
- 当需要第二个写入后端、调试 trace，或实测大量无效写入时，再抽取独立 diff API；当前直接在 SQLite 事务内比较 hash。
- 当 embedding provider/model 配置与批处理器实现后，再创建 `chunk_embeddings` 映射和 pending/retry 逻辑。

## 完成记录

Task 2 完成后记录 card 数量、行号移动时 FTS 写入数、陈旧事实删除、事务回滚结果、实际提交和技术债。最小闭环完成后即可进入工作区增量索引计划；后续加固不阻塞该入口。
