# SQLite 符号级增量代码索引实施计划

> **Required sub-skill（执行要求）：** 实施本计划时必须使用 `superpowers:using-git-worktrees` 创建独立 worktree，并在执行方式上选择 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。每个任务严格执行 RED -> GREEN -> REFACTOR，不跨任务提前实现。

**Goal（目标）：** 将当前常驻内存的工作区代码索引迁移到 LoopAgent 自有 SQLite 数据库，实现稳定符号 chunk、chunk 级差异更新、FTS/图检索、embedding 复用和扩展重启后的索引复用。

**Architecture（架构）：** VS Code 负责扫描、文件读取和 watcher 事件；Tree-sitter 对变化文件做完整 AST 解析；`CodeChunker` 生成稳定 `ExtractionSnapshot`；独立 worker 使用 `node:sqlite` 在事务内应用 chunk 差异；查询通过 SQLite exact/FTS/vector/graph 返回有界上下文，不在 Extension Host 保留完整仓库 Map。

**Tech Stack（技术栈）：** TypeScript、VS Code Extension API、Node 22 `node:sqlite`、`worker_threads`、SQLite WAL/FTS5、web-tree-sitter、Vitest、esbuild、`@vscode/test-electron`。

**设计规格：** `docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`

---

## 实施约束

1. 从包含设计提交 `b266634` 的 `main` 创建新 feature worktree，不在当前 `main` 工作区直接实现。
2. SQLite 是唯一持久化索引事实源；生产代码不得长期并行维护完整内存图或源码缓存。
3. 本计划不实现 `Tree.edit()`；变化文件仍完整解析，只有数据库更新、FTS 和 embedding 使用 chunk 粒度。
4. 迁移期间允许旧查询路径继续工作，但任务 14 完成后生产请求必须走 SQLite，任务 18 删除无消费者的旧实现。
5. 每次提交前运行该任务的针对性测试和 `git diff --check`；跨模块任务额外运行 `npm run typecheck`。
6. 调试 VS Code 时只复用一个 LoopAgent Extension Development Host，并始终使用 `npm run debug:vscode`。

## Task 1：提升运行时基线并验证 SQLite 能力

**Files:**

- Create: `src/extension/intelligence/storage/sqliteCapabilities.ts`
- Create: `test/intelligence/sqliteCapabilities.test.ts`
- Modify: `package.json`
- Modify: `esbuild.js`
- Modify: `test/packageManifest.test.ts`

**Step 1：写最低运行时与 SQLite 能力失败测试**

在 `test/packageManifest.test.ts` 增加：

```ts
it("requires a VS Code host with Node 22 sqlite support", () => {
  expect(manifest.engines.vscode).toBe("^1.101.0");
});
```

在 `test/intelligence/sqliteCapabilities.test.ts` 使用临时目录：

```ts
it("probes sqlite, WAL, foreign keys, and FTS5", () => {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-sqlite-"));
  const result = probeSqliteCapabilities(join(directory, "probe.sqlite"));

  expect(result).toEqual({ sqlite: true, wal: true, foreignKeys: true, fts5: true });
});
```

**Step 2：运行测试确认 RED**

Run:

```powershell
npm test -- test/packageManifest.test.ts test/intelligence/sqliteCapabilities.test.ts
```

Expected: FAIL，原因是最低 VS Code 仍为 `^1.96.0`，且 `probeSqliteCapabilities` 不存在。

**Step 3：实现最小能力探测**

`sqliteCapabilities.ts` 导出：

```ts
export type SqliteCapabilities = {
  sqlite: boolean;
  wal: boolean;
  foreignKeys: boolean;
  fts5: boolean;
};

export function probeSqliteCapabilities(databasePath: string): SqliteCapabilities;
```

实现使用 `DatabaseSync` 打开临时文件，执行以下语句并在 `finally` 中关闭数据库：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE VIRTUAL TABLE __loopagent_fts_probe USING fts5(text);
DROP TABLE __loopagent_fts_probe;
```

同时修改：

- `package.json`：`engines.vscode` 改为 `^1.101.0`。
- `esbuild.js`：extension target 改为 `node22`。

**Step 4：运行测试确认 GREEN**

Run:

```powershell
npm test -- test/packageManifest.test.ts test/intelligence/sqliteCapabilities.test.ts
npm run typecheck
npm run compile
```

Expected: PASS；`dist/extension.js` 正常生成。

**Step 5：提交**

```powershell
git add package.json esbuild.js src/extension/intelligence/storage/sqliteCapabilities.ts test/packageManifest.test.ts test/intelligence/sqliteCapabilities.test.ts
git diff --cached --check
git commit -m "build: require vscode node sqlite runtime"
```

## Task 2：定义索引类型、SQLite schema 与迁移

**Files:**

- Create: `src/extension/intelligence/storage/indexTypes.ts`
- Create: `src/extension/intelligence/storage/indexSchema.ts`
- Create: `src/extension/intelligence/storage/indexMigrations.ts`
- Create: `src/extension/intelligence/storage/indexDatabase.ts`
- Create: `test/intelligence/indexMigrations.test.ts`

**Step 1：写 schema 创建与幂等迁移失败测试**

测试必须覆盖：

```ts
it("creates the complete version-one schema", () => {
  const database = openTestDatabase();
  applyIndexMigrations(database);

  expect(listTables(database)).toEqual(
    expect.arrayContaining([
      "schema_migrations",
      "index_meta",
      "files",
      "nodes",
      "edges",
      "chunks",
      "chunk_fts",
      "embedding_cache",
      "chunk_embeddings",
      "import_bindings",
      "unresolved_references",
      "file_dependencies",
      "diagnostics",
      "index_jobs",
    ]),
  );
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
});

it("is idempotent and rejects a newer unknown schema", () => {
  const database = openTestDatabase();
  applyIndexMigrations(database);
  applyIndexMigrations(database);
  database.exec("PRAGMA user_version = 999");
  expect(() => applyIndexMigrations(database)).toThrow(/newer schema version/i);
});

it("backs up an incompatible database before rebuilding", () => {
  const databasePath = createDatabaseWithVersion(999);
  const result = openIndexDatabase(databasePath, { now: () => 12345 });
  expect(result.rebuilt).toBe(true);
  expect(result.backupPath).toBe(`${databasePath}.backup-12345`);
  expect(existsSync(result.backupPath!)).toBe(true);
  expect(result.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/indexMigrations.test.ts
```

Expected: FAIL，迁移模块和表尚不存在。

**Step 3：实现 version 1 schema**

`indexTypes.ts` 定义数据库边界使用的可序列化类型：

```ts
export type IndexJobEvent = "create" | "change" | "delete";
export type IndexJobStatus = "pending" | "running" | "failed";
export type FileIndexState = "pending" | "indexing" | "ready" | "failed" | "deleted";
export type EmbeddingStatus = "pending" | "ready" | "failed";
```

`indexSchema.ts` 使用设计规格中的精确字段创建所有表、外键和索引。至少建立：

```sql
CREATE INDEX idx_nodes_file ON nodes(file_id);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_edges_source ON edges(source_node_id);
CREATE INDEX idx_edges_target ON edges(target_node_id);
CREATE INDEX idx_chunks_file ON chunks(file_id);
CREATE INDEX idx_chunks_embedding_hash ON chunks(embedding_hash);
CREATE INDEX idx_jobs_status ON index_jobs(status, updated_at);
CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, search_text, tokenize='unicode61');
```

`indexMigrations.ts` 导出：

```ts
export const CURRENT_INDEX_SCHEMA_VERSION = 1;
export function applyIndexMigrations(database: DatabaseSync): void;
```

迁移必须包在事务中，成功后记录 `schema_migrations` 并设置 `PRAGMA user_version = 1`。

`indexDatabase.ts` 导出 `openIndexDatabase(databasePath, options)`。它先尝试迁移；遇到未知新版本或不可迁移 schema 时关闭连接，把原数据库、WAL 和 SHM 一起移动到同一 backup 前缀，再创建 version 1 数据库。普通 I/O 权限错误不得伪装成 schema 重建。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/indexMigrations.test.ts test/intelligence/sqliteCapabilities.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/storage/indexTypes.ts src/extension/intelligence/storage/indexSchema.ts src/extension/intelligence/storage/indexMigrations.ts src/extension/intelligence/storage/indexDatabase.ts test/intelligence/indexMigrations.test.ts
git diff --cached --check
git commit -m "feat(intelligence): add sqlite index schema"
```

## Task 3：建立 SQLite worker 协议与生命周期

**Files:**

- Create: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Create: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Create: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Create: `test/intelligence/sqliteIndexWorkerClient.test.ts`
- Create: `test/sqliteWorkerBundle.test.ts`
- Modify: `esbuild.js`

**Step 1：写 RPC、错误传播与 dispose 失败测试**

使用可注入的 fake worker 验证：

```ts
it("matches responses to requests and rejects worker errors", async () => {
  const worker = createFakeWorker();
  const client = createSqliteIndexWorkerClient({ worker });

  const statusPromise = client.getStatus();
  worker.respond({ id: worker.lastRequestId(), ok: true, value: { state: "ready" } });
  await expect(statusPromise).resolves.toEqual({ state: "ready" });

  const secondPromise = client.getStatus();
  worker.respond({ id: worker.lastRequestId(), ok: false, error: "database closed" });
  await expect(secondPromise).rejects.toThrow("database closed");
});

it("rejects pending requests and terminates on dispose", async () => {
  const worker = createFakeWorker();
  const client = createSqliteIndexWorkerClient({ worker });
  const pending = client.getStatus();
  await client.dispose();
  await expect(pending).rejects.toThrow(/disposed/i);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteIndexWorkerClient.test.ts test/sqliteWorkerBundle.test.ts
```

Expected: FAIL，worker 协议、client 和 bundle 尚不存在。

**Step 3：实现类型化协议和 worker entry**

协议必须是可辨识联合：

```ts
export type SqliteWorkerRequest =
  | { id: number; kind: "initialize"; databasePath: string }
  | { id: number; kind: "getStatus" }
  | { id: number; kind: "dispose" };

export type SqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
```

client 使用递增 request ID 和 `Map<number, PendingRequest>` 只管理尚未完成的 RPC，不缓存索引数据。worker 初始化时执行 capability probe、PRAGMA 和 migration。

修改 `esbuild.js`，新增 node22 CJS entry：

```js
const sqliteWorkerConfig = {
  ...extensionConfig,
  entryPoints: ["src/extension/intelligence/storage/sqliteIndexWorker.ts"],
  outfile: "dist/sqliteIndexWorker.js",
};
```

确保 build/watch 都包含该配置。`test/sqliteWorkerBundle.test.ts` 断言配置输出路径和 target，不在单元测试中启动 GUI。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteIndexWorkerClient.test.ts test/sqliteWorkerBundle.test.ts
npm run compile
Test-Path dist/sqliteIndexWorker.js
```

Expected: 测试通过，最后一条输出 `True`。

**Step 5：提交**

```powershell
git add esbuild.js src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteIndexWorkerClient.test.ts test/sqliteWorkerBundle.test.ts
git diff --cached --check
git commit -m "feat(intelligence): add sqlite index worker"
```

## Task 4：实现持久化更新队列与 writer 租约

**Files:**

- Create: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Create: `test/intelligence/sqliteIndexJobs.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

**Step 1：写事件合并、恢复和租约失败测试**

```ts
it("coalesces file events using the current filesystem outcome", () => {
  const store = createTestStore();
  store.enqueueFileEvent("file:///src/a.ts", "create");
  store.enqueueFileEvent("file:///src/a.ts", "change");
  expect(store.listPendingJobs()).toMatchObject([{ fileUri: "file:///src/a.ts", eventKind: "change" }]);

  store.enqueueFileEvent("file:///src/a.ts", "delete");
  expect(store.listPendingJobs()).toMatchObject([{ fileUri: "file:///src/a.ts", eventKind: "delete" }]);
});

it("recovers stale running jobs and enforces one writer lease", () => {
  const store = createTestStore({ now: () => 10_000 });
  store.insertRunningJob({ updatedAt: 1_000 });
  store.recoverInterruptedJobs({ staleAfterMs: 5_000 });
  expect(store.listPendingJobs()).toHaveLength(1);

  expect(store.acquireWriterLease("owner-a", 30_000)).toBe(true);
  expect(store.acquireWriterLease("owner-b", 30_000)).toBe(false);
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteIndexJobs.test.ts
```

Expected: FAIL，store 和 job API 不存在。

**Step 3：实现最小 store 与 RPC**

`SqliteIndexStore` 只接受已经打开且迁移完成的 `DatabaseSync`：

```ts
export class SqliteIndexStore {
  enqueueFileEvent(fileUri: string, eventKind: IndexJobEvent): void;
  claimNextJob(ownerId: string): IndexJob | undefined;
  completeJob(jobId: number): void;
  failJob(jobId: number, error: string): void;
  recoverInterruptedJobs(options: { staleAfterMs: number }): number;
  acquireWriterLease(ownerId: string, ttlMs: number): boolean;
  renewWriterLease(ownerId: string, ttlMs: number): boolean;
  releaseWriterLease(ownerId: string): void;
}
```

worker protocol 增加 `enqueueChanges`、`getPendingJobs` 和 lease 内部处理。生产 client 不暴露任意 SQL。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteIndexJobs.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteIndexJobs.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist index jobs and writer lease"
```

## Task 5：建立稳定节点身份与 ExtractionSnapshot

**Files:**

- Create: `src/extension/intelligence/indexing/stableIdentity.ts`
- Create: `src/extension/intelligence/indexing/extractionSnapshot.ts`
- Create: `test/intelligence/extractionSnapshot.test.ts`
- Modify: `src/extension/intelligence/storage/indexTypes.ts`

**Step 1：写行号移动后身份稳定的失败测试**

构造两份仅起始行不同的 `ExtractionResult`：

```ts
it("keeps stable node and edge ids when a symbol only moves", () => {
  const first = buildExtractionSnapshot(snapshotInput({ functionStartLine: 5, callLine: 6 }));
  const moved = buildExtractionSnapshot(snapshotInput({ functionStartLine: 25, callLine: 26 }));

  expect(moved.nodes[0]?.id).toBe(first.nodes[0]?.id);
  expect(moved.nodes[0]?.semanticKey).toBe(first.nodes[0]?.semanticKey);
  expect(moved.edges[0]?.source).toBe(first.edges[0]?.source);
  expect(moved.nodes[0]?.startLine).toBe(25);
});

it("distinguishes overloads by normalized signature", () => {
  expect(createSymbolSemanticKey(functionNode("run", "run(value: string): void"))).not.toBe(
    createSymbolSemanticKey(functionNode("run", "run(value: number): void")),
  );
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/extractionSnapshot.test.ts
```

Expected: FAIL，稳定身份和 snapshot builder 不存在。

**Step 3：实现稳定身份和引用重写**

`stableIdentity.ts` 导出：

```ts
export function createFileId(fileUri: string): string;
export function createSymbolSemanticKey(node: CodeNode, parentKey?: string): string;
export function createStableNodeId(fileId: string, semanticKey: string): string;
export function createStableChunkId(fileId: string, chunkKind: CodeChunkKind, semanticKey: string): string;
```

统一使用 SHA-256 十六进制摘要。`createSymbolSemanticKey` 使用 kind、qualified name 和 normalized signature，不包含 range。

`extractionSnapshot.ts` 定义：

```ts
export type SnapshotInput = {
  fileUri: string;
  filePath: string;
  parsed: ParsedSource;
  extraction: ExtractionResult;
};

export type ExtractionSnapshot = {
  file: SnapshotFile;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  importBindings: SnapshotImportBinding[];
  unresolvedReferences: SnapshotReference[];
  diagnostics: SnapshotDiagnostic[];
};
```

先建立旧 node ID 到稳定 node ID 的映射，再重写 edges、import bindings 和 unresolved references。该函数不接管 `parsed.tree` 的释放责任。`chunks` 字段在 Task 6 创建 `CodeChunk` 类型后加入，保证 Task 5 的中间提交可以独立类型检查。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/extractionSnapshot.test.ts test/intelligence/typescriptAdapter.test.ts test/intelligence/pythonAdapter.test.ts
npm run typecheck
```

Expected: PASS，现有 adapter 行为不变。

**Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/stableIdentity.ts src/extension/intelligence/indexing/extractionSnapshot.ts src/extension/intelligence/storage/indexTypes.ts test/intelligence/extractionSnapshot.test.ts
git diff --cached --check
git commit -m "feat(intelligence): create stable extraction snapshots"
```

## Task 6：生成 file、symbol、class 与 test card chunks

**Files:**

- Create: `src/extension/intelligence/chunking/chunkTypes.ts`
- Create: `src/extension/intelligence/chunking/codeChunker.ts`
- Create: `src/extension/intelligence/chunking/searchText.ts`
- Create: `test/intelligence/codeChunker.test.ts`
- Modify: `src/extension/intelligence/indexing/extractionSnapshot.ts`

**Step 1：写 card 内容、稳定 ID 和检索拆词失败测试**

```ts
it("builds stable cards without volatile source ranges", () => {
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

it("keeps card ids stable when ranges move", () => {
  const before = createCodeChunks(snapshotFixture("src/a.ts", { startLine: 5 }));
  const after = createCodeChunks(snapshotFixture("src/a.ts", { startLine: 50 }));
  expect(after.map((chunk) => chunk.id)).toEqual(before.map((chunk) => chunk.id));
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/codeChunker.test.ts
```

Expected: FAIL，chunker 和类型不存在。

**Step 3：实现 card chunks 和三层 hash**

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

`searchText.ts` 复用当前 `searchIndex.ts` 的 camelCase、snake_case、kebab-case 和路径拆词行为，但输出确定性字符串。card 字段排序必须固定，hash 使用 UTF-8 SHA-256。

`createCodeChunks(snapshotCore)` 先生成 file/symbol/class/test card；callsite 和 source body 在后续任务补充。Task 6 将 `chunks: CodeChunk[]` 加入 `ExtractionSnapshot`，并让 `buildExtractionSnapshot` 在稳定节点映射完成后调用 chunker。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/codeChunker.test.ts test/intelligence/searchIndex.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/chunking/chunkTypes.ts src/extension/intelligence/chunking/codeChunker.ts src/extension/intelligence/chunking/searchText.ts src/extension/intelligence/indexing/extractionSnapshot.ts test/intelligence/codeChunker.test.ts
git diff --cached --check
git commit -m "feat(intelligence): generate stable code cards"
```

## Task 7：生成 source body、callsite 和超大函数子块

**Files:**

- Create: `src/extension/intelligence/chunking/sourceBodyChunker.ts`
- Create: `test/intelligence/sourceBodyChunker.test.ts`
- Modify: `src/extension/intelligence/chunking/codeChunker.ts`
- Modify: `test/intelligence/codeChunker.test.ts`

**Step 1：写大小边界和 AST 子块失败测试**

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
  expect(chunks.every((chunk) => chunk.semanticKey.startsWith("function:"))).toBe(true);
});

it("uses a stable parent-and-statement key instead of line numbers", () => {
  const before = createSourceBodyChunks(parsedFunction({ leadingBlankLines: 0 }));
  const moved = createSourceBodyChunks(parsedFunction({ leadingBlankLines: 20 }));
  expect(moved.map((chunk) => chunk.id)).toEqual(before.map((chunk) => chunk.id));
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sourceBodyChunker.test.ts
```

Expected: FAIL，source body chunker 不存在。

**Step 3：实现边界规则**

规则固定为：

- 小函数整体 chunk：不超过 `120` 行且不超过 `4,000` 字符。
- 超大函数优先按 `if`、`for`、`while`、`try`、`switch`、callback 和 object literal 的 named AST range 切分。
- 子块目标 `1,500-3,000` 字符，硬上限 `5,000` 字符。
- overlap 为前后最多 `8` 行，只进入 `sourceText`，不进入 `embeddingText`。
- 子块语义键使用父符号键、AST node type、规范化首语句 hash；ordinal 只在冲突时追加。

callsite card 只为通用 AST 调用模式生成，不增加项目业务词表。Task 7 把 chunker 签名扩展为 `createCodeChunks(snapshotCore, parsed)`，只在当前解析生命周期内读取 AST；返回的 `ExtractionSnapshot` 不保存 tree。

必须在 `parsed.tree?.delete()` 之前完成 source body 切块。测试继续断言 tree 最终只释放一次。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sourceBodyChunker.test.ts test/intelligence/codeChunker.test.ts test/intelligence/workspaceAstIntegration.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/chunking/sourceBodyChunker.ts src/extension/intelligence/chunking/codeChunker.ts test/intelligence/sourceBodyChunker.test.ts test/intelligence/codeChunker.test.ts
git diff --cached --check
git commit -m "feat(intelligence): split source bodies by ast boundaries"
```

## Task 8：实现纯函数 Snapshot 差异分类

**Files:**

- Create: `src/extension/intelligence/indexing/snapshotDiff.ts`
- Create: `test/intelligence/snapshotDiff.test.ts`
- Modify: `src/extension/intelligence/storage/indexTypes.ts`

**Step 1：写六种差异状态失败测试**

```ts
it.each([
  ["unchanged", unchangedPair()],
  ["metadata-only", rangeOnlyPair()],
  ["search-changed", searchChangedPair()],
  ["embedding-changed", embeddingChangedPair()],
])("classifies %s chunks", (expected, [stored, incoming]) => {
  expect(diffChunk(stored, incoming).kind).toBe(expected);
});

it("reports added and removed stable ids", () => {
  const diff = diffExtractionSnapshot(storedSnapshot(), incomingSnapshot());
  expect(diff.addedChunks.map((chunk) => chunk.id)).toEqual(["chunk:new"]);
  expect(diff.removedChunkIds).toEqual(["chunk:old"]);
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/snapshotDiff.test.ts
```

Expected: FAIL，diff API 不存在。

**Step 3：实现确定性差异结果**

导出：

```ts
export type ChunkDiffKind =
  | "unchanged"
  | "metadata-only"
  | "search-changed"
  | "embedding-changed";

export function diffChunk(stored: StoredChunk, incoming: CodeChunk): ChunkDiff;
export function diffExtractionSnapshot(
  stored: StoredFileSnapshot,
  incoming: ExtractionSnapshot,
): SnapshotChangeSet;
```

`SnapshotChangeSet` 分开列出 node、edge、binding、reference、diagnostic、chunk 和 embedding 映射操作，数组按稳定 ID 排序，保证测试和 SQL 写入顺序可复现。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/snapshotDiff.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/snapshotDiff.ts src/extension/intelligence/storage/indexTypes.ts test/intelligence/snapshotDiff.test.ts
git diff --cached --check
git commit -m "feat(intelligence): diff stable code snapshots"
```

## Task 9：在事务内应用 Snapshot 差异并维护 FTS

**Files:**

- Create: `test/intelligence/sqliteSnapshotStore.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

**Step 1：写初始写入、局部更新和回滚失败测试**

```ts
it("updates only changed chunks and keeps FTS consistent", () => {
  const store = createTestStore({ now: sequence(100, 200) });
  store.applyFileSnapshot(initialTwoFunctionSnapshot());
  const before = store.readStoredFileSnapshot("file:src/a.ts");

  store.applyFileSnapshot(snapshotWithOnlySecondFunctionChanged());
  const after = store.readStoredFileSnapshot("file:src/a.ts");

  expect(after.chunks[0]?.updatedAt).toBe(before.chunks[0]?.updatedAt);
  expect(after.chunks[1]?.updatedAt).toBe(200);
  expect(store.searchFts("newSecondBody")).toHaveLength(1);
  expect(store.searchFts("oldSecondBody")).toHaveLength(0);
});

it("rolls back the whole file update when one edge violates a constraint", () => {
  const store = createTestStore();
  store.applyFileSnapshot(initialTwoFunctionSnapshot());
  expect(() => store.applyFileSnapshot(snapshotWithMissingEdgeTarget())).toThrow();
  expect(store.readStoredFileSnapshot("file:src/a.ts")).toEqual(
    expect.objectContaining({ file: expect.objectContaining({ contentHash: "initial" }) }),
  );
});
```

增加 range-only 用例，断言 chunk `updated_at`、FTS row 和 embedding 映射都不变化，只有 range 列变化。

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteSnapshotStore.test.ts
```

Expected: FAIL，store 尚不能应用 snapshot。

**Step 3：实现事务写入顺序**

`applyFileSnapshot` 必须按以下顺序执行单个 SQLite transaction：

1. 读取旧文件 snapshot。
2. 调用 `diffExtractionSnapshot`。
3. 删除 removed chunk 的 FTS 行和所属事实。
4. upsert nodes、bindings、references、diagnostics 和 edges。
5. 只对 search hash 改变的 chunk 删除并重插 FTS。
6. 只对 embedding hash 改变的映射设置 `pending`。
7. upsert file hash、mtime、版本和 `ready` 状态。
8. 提交；任一步失败自动 rollback。

RPC 增加：

```ts
| { id: number; kind: "applyFileSnapshot"; snapshot: ExtractionSnapshot }
| { id: number; kind: "removeFile"; fileUri: string }
```

worker 只返回写入统计，不回传完整存储 snapshot：

```ts
export type SnapshotWriteStats = {
  inserted: number;
  updated: number;
  removed: number;
  ftsWrites: number;
  embeddingsInvalidated: number;
};
```

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteSnapshotStore.test.ts test/intelligence/snapshotDiff.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteSnapshotStore.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist chunk snapshot diffs"
```

## Task 10：实现启动扫描与 WorkspaceIndexer

**Files:**

- Create: `src/extension/intelligence/indexing/workspaceIndexer.ts`
- Create: `test/intelligence/workspaceIndexer.test.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/mocks/vscode.ts`

**Step 1：写重启复用和变化文件抽取失败测试**

```ts
it("skips parser and chunker for unchanged persisted files after restart", async () => {
  const store = fakePersistentStore({ files: [storedFile({ mtime: 10, byteLength: 100, contentHash: "same" })] });
  const parserRuntime = fakeParserRuntime();
  const indexer = createWorkspaceIndexer(indexerDeps({ store, parserRuntime, stat: { mtime: 10, size: 100 } }));

  await indexer.scanWorkspace();

  expect(parserRuntime.parse).not.toHaveBeenCalled();
  expect(store.applyFileSnapshot).not.toHaveBeenCalled();
});

it("parses, chunks, persists, and releases one changed file", async () => {
  const { indexer, parserRuntime, tree, store } = changedFileIndexerFixture();
  await indexer.processNextJob();
  expect(parserRuntime.parse).toHaveBeenCalledOnce();
  expect(store.applyFileSnapshot).toHaveBeenCalledOnce();
  expect(tree.delete).toHaveBeenCalledOnce();
});

it("reindexes unchanged files when extractor or chunker versions change", async () => {
  const fixture = versionChangedIndexerFixture({ storedExtractor: 1, currentExtractor: 2 });
  await fixture.indexer.scanWorkspace();
  expect(fixture.store.enqueueChanges).toHaveBeenCalledWith([
    expect.objectContaining({ eventKind: "change" }),
  ]);
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts
```

Expected: FAIL，WorkspaceIndexer 不存在。

**Step 3：实现扫描和单 job 处理**

定义依赖边界：

```ts
export type WorkspaceIndexerDeps = {
  listWorkspaceFiles(): Promise<WorkspaceFileRef[]>;
  statFile(file: WorkspaceFileRef): Promise<{ mtime: number; size: number }>;
  readFile(file: WorkspaceFileRef): Promise<string>;
  parserRuntime: ParserRuntime;
  getAdapter(languageId: string): LanguageAdapter | undefined;
  store: IndexStoreClient;
};

export type WorkspaceIndexer = {
  scanWorkspace(): Promise<void>;
  processNextJob(): Promise<boolean>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
};
```

扫描先比较 URI 集合、size 和 mtime；只有候选变化文件才读取并计算 SHA-256。处理 job 时重新 stat，读取最新内容，完成 parse -> extract -> snapshot -> persist，最后在 `finally` 删除 tree。

扩展 `VsCodeWorkspaceApi` mock，加入 `workspace.fs.stat`。此任务不切换 prompt 查询路径。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts test/intelligence/workspaceAstIntegration.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/workspaceIndexer.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/workspaceIndexer.test.ts test/mocks/vscode.ts
git diff --cached --check
git commit -m "feat(intelligence): index changed workspace files"
```

## Task 11：把 watcher 事件写入持久化队列

**Files:**

- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `test/intelligence/vscodeWorkspaceIntelligence.test.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`

**Step 1：写 watcher 持久化和 dispose 失败测试**

替换依赖 `sourceCache` 的旧测试，新增：

```ts
it("persists create, change, and delete events instead of caching sources", async () => {
  const watcher = createFakeWatcher();
  const store = fakeIndexStoreClient();
  const intelligence = createVsCodeWorkspaceIntelligence(fakeVsCodeApi({ watcher }), { store });

  watcher.fireCreate(uri("src/new.ts"));
  watcher.fireChange(uri("src/a.ts"));
  watcher.fireDelete(uri("src/old.ts"));

  expect(store.enqueueChanges).toHaveBeenNthCalledWith(1, [
    { fileUri: expect.stringContaining("src/new.ts"), eventKind: "create" },
  ]);
  expect(store.enqueueChanges).toHaveBeenNthCalledWith(2, [
    { fileUri: expect.stringContaining("src/a.ts"), eventKind: "change" },
  ]);
  expect(store.enqueueChanges).toHaveBeenNthCalledWith(3, [
    { fileUri: expect.stringContaining("src/old.ts"), eventKind: "delete" },
  ]);
  await intelligence.dispose();
  expect(watcher.dispose).toHaveBeenCalledOnce();
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts
```

Expected: FAIL，当前实现仍维护 Map/Set，且 `WorkspaceIntelligence` 没有 `dispose()`。

**Step 3：实现持久化 watcher 生命周期**

`WorkspaceIntelligence` 增加：

```ts
dispose(): Promise<void>;
```

`createVsCodeWorkspaceIntelligence` 在 worker 初始化完成后注册 watcher；handler 只规范化 URI 并调用 `enqueueChanges`。移除 `sourceCache`、`dirtyPaths`、`deletedPaths` 的 watcher 用途，但旧 prompt 路径需要的源码读取暂时改为直接按需 `workspace.fs.readFile`，直到 Task 14 完成查询迁移。

dispose 顺序：停止 watcher -> 停止 indexer -> 完成/回滚 job -> 释放 worker client。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts test/intelligence/workspaceIndexer.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/vscodeWorkspaceIntelligence.ts src/extension/intelligence/workspaceIntelligence.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist workspace file events"
```

## Task 12：持久化 import、reference 与跨文件依赖重解析

**Files:**

- Create: `src/extension/intelligence/resolution/sqliteReferenceResolver.ts`
- Create: `test/intelligence/sqliteReferenceResolver.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

**Step 1：写只重算关系、不重跑 parser 的失败测试**

```ts
it("re-resolves dependent edges after an exported symbol changes", async () => {
  const store = createStoreWithImportedCall();
  store.applyFileSnapshot(exporterRenamedSnapshot());

  const result = store.resolveImpactedDependencies("file:src/exporter.ts");

  expect(result.impactedFileIds).toEqual(["file:src/consumer.ts"]);
  expect(result.removedEdgeIds).toContain("edge:consumer:calls:oldExport");
  expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: "oldExport" }));
});
```

另一个测试通过 fake parser 断言依赖文件没有重新 parse。

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteReferenceResolver.test.ts
```

Expected: FAIL，SQLite resolver 不存在。

**Step 3：实现关系证据查询和有界重解析**

`sqliteReferenceResolver.ts` 导出纯函数和 SQL store adapter：

```ts
export function resolvePersistedReferences(input: {
  changedFileId: string;
  nodes: readonly SnapshotNode[];
  bindings: readonly SnapshotImportBinding[];
  references: readonly SnapshotReference[];
  dependencies: readonly FileDependency[];
}): PersistedResolutionResult;
```

store 根据 `file_dependencies.to_file_id` 找依赖文件，加载这些文件持久化的 binding/reference 和必要 node 候选，替换关系边与 unresolved rows。禁止调用 parser 或读取依赖文件源码。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteReferenceResolver.test.ts test/intelligence/referenceResolver.test.ts test/intelligence/modulePathResolver.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/resolution/sqliteReferenceResolver.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteReferenceResolver.test.ts
git diff --cached --check
git commit -m "feat(intelligence): resolve persisted code references"
```

## Task 13：实现 SQLite exact token 与 FTS 检索

**Files:**

- Create: `src/extension/intelligence/retrieval/retrievalTypes.ts`
- Create: `src/extension/intelligence/retrieval/sqliteRetriever.ts`
- Create: `test/intelligence/sqliteRetriever.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

**Step 1：写路径、qualified name、camelCase 和硬 limit 失败测试**

```ts
it("retrieves exact identifiers, paths, and split qualified names", async () => {
  const retriever = createRetrieverWithCards([
    card("src/extension.ts", "LoopAgentChatViewProvider.startRun"),
    card("src/extension/intelligence/vscodeWorkspaceIntelligence.ts", "createVsCodeWorkspaceIntelligence"),
  ]);

  const hits = await retriever.searchText("extension.ts LoopAgentChatViewProvider.startRun", 1);
  expect(hits).toEqual([
    expect.objectContaining({ qualifiedName: expect.stringContaining("LoopAgentChatViewProvider.startRun") }),
  ]);
});

it("returns bounded FTS results without loading all chunks", async () => {
  const retriever = createRetrieverWithManyCards(100);
  const hits = await retriever.searchText("workspace incremental refresh", 5);
  expect(hits).toHaveLength(5);
  expect(retriever.stats().loadedChunkRows).toBeLessThanOrEqual(5);
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteRetriever.test.ts
```

Expected: FAIL，retriever 不存在。

**Step 3：实现有界 SQL 检索**

定义：

```ts
export type RetrievalHit = {
  chunkId: string;
  nodeId?: string;
  filePath: string;
  qualifiedName?: string;
  chunkKind: CodeChunkKind;
  source: "exact" | "fts" | "vector" | "graph";
  rank: number;
  score: number;
};

export type SqliteRetriever = {
  searchText(query: string, limit: number): Promise<RetrievalHit[]>;
  getChunks(chunkIds: readonly string[]): Promise<RetrievedChunk[]>;
};
```

exact token 查询使用预计算 `search_text` 的标识符 token；FTS 查询对用户输入做安全转义，不拼接原始 SQL。所有查询必须接收明确 limit，并通过 worker RPC 返回扁平 DTO。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteRetriever.test.ts test/intelligence/searchIndex.test.ts
npm run typecheck
```

Expected: PASS，旧 SearchIndex 测试继续作为拆词行为基线。

**Step 5：提交**

```powershell
git add src/extension/intelligence/retrieval/retrievalTypes.ts src/extension/intelligence/retrieval/sqliteRetriever.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteRetriever.test.ts
git diff --cached --check
git commit -m "feat(intelligence): retrieve persisted code chunks"
```

## Task 14：实现有界 SQL 图扩展与 HybridRetriever

**Files:**

- Create: `src/extension/intelligence/retrieval/sqliteGraphQuery.ts`
- Create: `src/extension/intelligence/retrieval/hybridRetriever.ts`
- Create: `test/intelligence/sqliteGraphQuery.test.ts`
- Create: `test/intelligence/hybridRetriever.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

**Step 1：写深度、节点数、边数和融合排序失败测试**

```ts
it("expands only within graph budgets", async () => {
  const graph = createPersistedCallChain(20);
  const result = await graph.expand(["node:0"], { depth: 2, maxNodes: 5, maxEdges: 6 });
  expect(result.nodes.length).toBeLessThanOrEqual(5);
  expect(result.edges.length).toBeLessThanOrEqual(6);
  expect(result.nodes).toContainEqual(expect.objectContaining({ id: "node:2" }));
  expect(result.nodes).not.toContainEqual(expect.objectContaining({ id: "node:3" }));
});

it("fuses exact, FTS, vector, and graph ranks deterministically", async () => {
  const result = await createHybridFixture().retrieve("model integration", focusedProfile());
  expect(result.hits[0]?.chunkId).toBe("chunk:providerRegistry");
  expect(result.trace.sources).toEqual(expect.arrayContaining(["exact", "fts", "vector", "graph"]));
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteGraphQuery.test.ts test/intelligence/hybridRetriever.test.ts
```

Expected: FAIL，graph query 和 hybrid retriever 不存在。

**Step 3：实现有界查询与 RRF**

`sqliteGraphQuery.ts` 使用 source/target 索引和有界 recursive CTE；depth、maxNodes、maxEdges 均为必填参数，禁止生产 API 返回完整图。

`HybridRetriever` 接口：

```ts
export type HybridRetriever = {
  retrieve(query: string, profile: CodeIntelligenceBudgetProfile): Promise<RetrievedCodeContext>;
};

export type RetrievedCodeContext = {
  entryNodes: CodeNode[];
  relatedNodes: CodeNode[];
  edges: CodeEdge[];
  chunks: RetrievedChunk[];
  trace: RetrievalTrace;
  truncated: boolean;
};
```

融合公式使用设计中的 `k = 60` RRF。缺少某一路径时不添加该项；相同分数按 stable chunk ID 排序。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteGraphQuery.test.ts test/intelligence/hybridRetriever.test.ts test/intelligence/semanticGraph.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/retrieval/sqliteGraphQuery.ts src/extension/intelligence/retrieval/hybridRetriever.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteGraphQuery.test.ts test/intelligence/hybridRetriever.test.ts
git diff --cached --check
git commit -m "feat(intelligence): add bounded hybrid code retrieval"
```

## Task 15：把模型上下文入口迁移到 SQLite 检索

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

**Step 1：写 SQLite-only 上下文失败测试**

```ts
it("builds prompts from bounded retrieved chunks without a full graph or search index", async () => {
  const retriever = fakeHybridRetriever(retrievedProviderContext());
  const intelligence = createWorkspaceIntelligence({ retriever, indexer: fakeReadyIndexer() });

  const prompt = await intelligence.buildCodeIntelligencePrompt("模型集成是怎么实现的");

  expect(prompt).toContain("providerRegistry.ts");
  expect(prompt).toContain("createConfiguredAgentRunner");
  expect(retriever.retrieve).toHaveBeenCalledOnce();
  expect(intelligence).not.toHaveProperty("graph");
  expect(intelligence).not.toHaveProperty("searchIndex");
});

it("uses the last committed index when pending work exceeds the query wait budget", async () => {
  const indexer = fakeIndexerThatTimesOut();
  const intelligence = createWorkspaceIntelligence({ retriever: fakeHybridRetriever(oldCommittedContext()), indexer });
  const prompt = await intelligence.buildCodeIntelligencePrompt("explain startRun");
  expect(prompt).toContain("索引状态: partial");
  expect(prompt).toContain("startRun");
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/codeIntelligenceContext.test.ts test/intelligence/workspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
```

Expected: FAIL，context 仍要求完整 `SemanticGraph` 和 `SearchIndex`。

**Step 3：迁移接口并保留预算行为**

`createCodeIntelligenceContext` 改为：

```ts
export function createCodeIntelligenceContext(options: {
  query: string;
  retrieved: RetrievedCodeContext;
  maxChars?: number;
}): CodeIntelligenceResult;
```

它只做 snippet 排序、行数/字符裁剪和 fallback，不再读取源码或遍历图。`WorkspaceIntelligence` 依赖 `WorkspaceIndexer` 和 `HybridRetriever`；查询前最多等待 pending index job `2,000ms`，超时则使用上一版已提交索引并标记 `partial`。

prompt 增加 retrieval trace、chunk 类型统计和 index generation，不输出数据库绝对路径。

provider registry 必须继续优先复用 extension 注入的同一个 `WorkspaceIntelligence`，禁止为每次模型请求新建 SQLite worker。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/codeIntelligenceContext.test.ts test/intelligence/codeIntelligencePrompt.test.ts test/intelligence/workspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/context/codeIntelligenceContext.ts src/extension/intelligence/context/codeIntelligencePrompt.ts src/extension/intelligence/workspaceIntelligence.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts src/extension/model/providerRegistry.ts test/intelligence/codeIntelligenceContext.test.ts test/intelligence/codeIntelligencePrompt.test.ts test/intelligence/workspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
git diff --cached --check
git commit -m "feat(intelligence): build context from sqlite retrieval"
```

## Task 16：实现 embedding 内容寻址缓存与有界向量扫描

**Files:**

- Create: `src/extension/intelligence/embedding/embeddingProvider.ts`
- Create: `src/extension/intelligence/embedding/embeddingCoordinator.ts`
- Create: `src/extension/intelligence/retrieval/vectorIndex.ts`
- Create: `test/intelligence/embeddingCoordinator.test.ts`
- Create: `test/intelligence/vectorIndex.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `src/extension/intelligence/retrieval/hybridRetriever.ts`

**Step 1：写未变化复用、变化失效和批量扫描失败测试**

```ts
it("embeds only pending unique content hashes", async () => {
  const provider = fakeEmbeddingProvider();
  const coordinator = createEmbeddingCoordinator({ store: storeWithDuplicatePendingHashes(), provider });
  await coordinator.runBatch();
  expect(provider.embed).toHaveBeenCalledWith([expect.any(String)]);
  expect(provider.embed.mock.calls[0]?.[0]).toHaveLength(1);
});

it("keeps an unchanged embedding and invalidates only changed chunks", () => {
  const store = createStoreWithReadyEmbeddings();
  store.applyFileSnapshot(snapshotWithOneChangedEmbeddingHash());
  expect(store.getChunkEmbedding("chunk:unchanged").status).toBe("ready");
  expect(store.getChunkEmbedding("chunk:changed").status).toBe("pending");
});

it("scans vectors in batches and maintains a bounded top k", async () => {
  const index = createVectorIndex(storeWithEmbeddings(1_000), { batchSize: 256, maxCards: 20_000 });
  const hits = await index.search(queryVector(), 10);
  expect(hits).toHaveLength(10);
  expect(index.stats().maxLoadedAtOnce).toBeLessThanOrEqual(256);
});

it("rebuilds only embedding mappings when the configured model changes", async () => {
  const store = createStoreWithReadyEmbeddings({ model: "old-model" });
  const coordinator = createEmbeddingCoordinator({ store, provider: fakeProvider({ model: "new-model" }) });
  await coordinator.reconcileModel();
  expect(store.snapshotWriteCount()).toBe(0);
  expect(store.pendingEmbeddingCount("new-model")).toBeGreaterThan(0);
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/embeddingCoordinator.test.ts test/intelligence/vectorIndex.test.ts
```

Expected: FAIL，embedding lifecycle 和 vector index 不存在。

**Step 3：实现 provider-neutral 生命周期**

```ts
export type EmbeddingProvider = {
  readonly id: string;
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
};
```

coordinator 每批 claim pending 映射，按 `(provider, model, embedding_hash)` 去重，成功后先写 `embedding_cache` 再绑定 chunks；失败增加 attempts 和 last error，不阻塞 FTS 查询。

`VectorIndex` 只在 worker 中以每批 `256` 行扫描，默认最多 `20,000` 个 card；超过上限返回 `skippedReason`，不把 vector 发到 Extension Host。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/embeddingCoordinator.test.ts test/intelligence/vectorIndex.test.ts test/intelligence/hybridRetriever.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add src/extension/intelligence/embedding/embeddingProvider.ts src/extension/intelligence/embedding/embeddingCoordinator.ts src/extension/intelligence/retrieval/vectorIndex.ts src/extension/intelligence/retrieval/hybridRetriever.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/embeddingCoordinator.test.ts test/intelligence/vectorIndex.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist and reuse code embeddings"
```

## Task 17：实现可配置 OpenAI-compatible EmbeddingProvider

**Files:**

- Create: `src/extension/intelligence/embedding/embeddingConfig.ts`
- Create: `src/extension/intelligence/embedding/openAiCompatibleEmbeddingProvider.ts`
- Create: `test/intelligence/embeddingConfig.test.ts`
- Create: `test/intelligence/openAiCompatibleEmbeddingProvider.test.ts`
- Modify: `package.json`

**Step 1：写禁用默认值、SecretStorage 和请求协议失败测试**

```ts
it("keeps embeddings disabled until all required settings and a secret exist", async () => {
  const config = await getEmbeddingRuntimeConfig(fakeContext(), fakeWorkspaceConfig({ enabled: false }));
  expect(config).toEqual({ enabled: false });
});

it("posts an OpenAI-compatible embedding request without leaking the key", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
  const provider = createOpenAiCompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example/v1",
    apiKey: "secret-key",
    model: "embedding-model",
    fetchImpl,
  });
  await expect(provider.embed(["symbol card"])).resolves.toEqual([[0.1, 0.2]]);
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://embedding.example/v1/embeddings",
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-key" }) }),
  );
});
```

增加错误用例：HTTP 非 2xx、data 缺失、index 不连续、向量维度不一致、abort。

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts
```

Expected: FAIL，配置和 provider 不存在。

**Step 3：实现显式配置和安全密钥读取**

在 `package.json` 增加：

```json
"loopagent.codeIndex.embedding.enabled": { "type": "boolean", "default": false },
"loopagent.codeIndex.embedding.baseUrl": { "type": "string", "default": "" },
"loopagent.codeIndex.embedding.model": { "type": "string", "default": "" }
```

密钥只存 `SecretStorage` 的 `loopagent.codeIndex.embedding.apiKey`。enabled 为 false、baseUrl/model/key 任一缺失时不创建 provider，并返回明确诊断；不得复用或记录聊天模型 API key。

provider 保持批量输入顺序，验证所有向量维度一致，错误文本不得包含 Authorization header。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts test/packageManifest.test.ts
npm run typecheck
```

Expected: PASS。

**Step 5：提交**

```powershell
git add package.json src/extension/intelligence/embedding/embeddingConfig.ts src/extension/intelligence/embedding/openAiCompatibleEmbeddingProvider.ts test/intelligence/embeddingConfig.test.ts test/intelligence/openAiCompatibleEmbeddingProvider.test.ts
git diff --cached --check
git commit -m "feat(intelligence): configure code embedding provider"
```

## Task 18：接入扩展生命周期和索引管理命令

**Files:**

- Modify: `package.json`
- Modify: `src/extension.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/packageManifest.test.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`
- Create: `test/codeIndexCommands.test.ts`
- Modify: `test/mocks/vscode.ts`

**Step 1：写 storageUri、单实例、命令和清理失败测试**

```ts
it("creates one workspace index with storageUri and disposes it on deactivation", async () => {
  const context = fakeExtensionContext({ storageUri: uri("E:/storage/workspace") });
  activate(context);
  expect(createVsCodeWorkspaceIntelligence).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ storageUri: context.storageUri }),
  );
  await disposeRegisteredSubscriptions(context);
  expect(workspaceIntelligence.dispose).toHaveBeenCalledOnce();
});

it("rebuilds, clears, reports status, and manages the embedding key", async () => {
  const fixture = activateCommandFixture();
  await fixture.execute("loopagent.rebuildCodeIndex");
  await fixture.execute("loopagent.clearCodeIndex");
  const status = await fixture.execute("loopagent.showCodeIndexStatus");
  await fixture.execute("loopagent.setEmbeddingApiKey");
  await fixture.execute("loopagent.clearEmbeddingApiKey");
  expect(fixture.index.rebuild).toHaveBeenCalledOnce();
  expect(fixture.index.clear).toHaveBeenCalledOnce();
  expect(status).toEqual(expect.objectContaining({ state: "ready" }));
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/extensionWorkspaceIntelligence.test.ts test/codeIndexCommands.test.ts test/packageManifest.test.ts
```

Expected: FAIL，storageUri 和命令尚未接入。

**Step 3：实现命令和确定性关闭顺序**

贡献并注册：

```text
loopagent.rebuildCodeIndex
loopagent.clearCodeIndex
loopagent.showCodeIndexStatus
loopagent.setEmbeddingApiKey
loopagent.clearEmbeddingApiKey
```

`showCodeIndexStatus` 显示状态的同时返回可序列化 DTO，供 Extension Host 集成测试调用。`clear` 顺序固定为 watcher stop -> indexer stop -> worker dispose -> 删除 `.sqlite`、`-wal`、`-shm` -> 创建新 worker。`rebuild` 使用新临时库，初始化成功后再替换旧库。

无 `storageUri` 时创建 empty workspace intelligence，不打开数据库。所有 disposable 注册到 `context.subscriptions`。

**Step 4：运行测试确认 GREEN**

```powershell
npm test -- test/extensionWorkspaceIntelligence.test.ts test/codeIndexCommands.test.ts test/packageManifest.test.ts test/providerRegistryCodeContext.test.ts
npm run typecheck
npm run compile
```

Expected: PASS。

**Step 5：提交**

```powershell
git add package.json src/extension.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/packageManifest.test.ts test/extensionWorkspaceIntelligence.test.ts test/codeIndexCommands.test.ts test/mocks/vscode.ts
git diff --cached --check
git commit -m "feat(intelligence): manage persistent code index lifecycle"
```

## Task 19：删除生产路径的旧内存索引和过期测试

**Files:**

- Delete when `rg` confirms no consumers: `src/extension/intelligence/graph/semanticGraph.ts`
- Delete when `rg` confirms no consumers: `src/extension/intelligence/graph/graphTraverser.ts`
- Delete when `rg` confirms no consumers: `src/extension/intelligence/graph/searchIndex.ts`
- Delete when `rg` confirms no consumers: `src/extension/intelligence/resolution/referenceResolver.ts`
- Delete corresponding obsolete tests after equivalent SQLite coverage exists
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md`
- Modify: `docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md`

**Step 1：写架构边界失败测试**

在 `test/intelligence/workspaceIntelligence.test.ts` 增加源级约束：

```ts
it("does not retain repository-wide source, extraction, graph, or token maps", () => {
  const source = readFileSync(resolve("src/extension/intelligence/workspaceIntelligence.ts"), "utf8");
  const vscodeSource = readFileSync(resolve("src/extension/intelligence/vscodeWorkspaceIntelligence.ts"), "utf8");
  expect(source).not.toMatch(/extractionCacheByFile|createSemanticGraph|createSearchIndex/);
  expect(vscodeSource).not.toMatch(/sourceCache|dirtyPaths|deletedPaths/);
});
```

**Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/workspaceIntelligence.test.ts
```

Expected: FAIL，旧 cache 和 graph 创建代码仍存在。

**Step 3：确认消费者并删除旧实现**

先运行：

```powershell
rg -n "semanticGraph|graphTraverser|searchIndex|referenceResolver|readSourceRangeFromText" src test
```

只有 SQLite 新路径和等价测试都已覆盖时才删除文件。保留仍被 chunker 使用的纯拆词 helper 时，应移动到 `chunking/searchText.ts`，不能为保留文件而保留完整 Map 实现。

同步更新两份旧设计文档，明确 SQLite 规格已经取代内存缓存作为最终状态，不留下“长期保留 SearchIndex”的陈述。

**Step 4：运行测试确认 GREEN**

```powershell
npm test
npm run typecheck
npm run compile
rg -n "extractionCacheByFile|sourceCache|dirtyPaths|deletedPaths|createSemanticGraph|createSearchIndex" src/extension/intelligence
```

Expected: 测试、类型检查、编译通过；最后一条无生产命中并以 exit code 1 结束，执行计划时应将“无匹配”记录为通过而不是命令失败。

**Step 5：提交**

```powershell
git add -A src/extension/intelligence test/intelligence docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md
git diff --cached --check
git commit -m "refactor(intelligence): remove legacy in-memory index"
```

## Task 20：最低版本 Extension Host、打包 VSIX 与真实工作流验证

**Files:**

- Create: `scripts/run-sqlite-vscode-test.mjs`
- Create: `test/integration/sqliteCodeIndexExtension.test.ts`
- Create: `docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-verification.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `esbuild.js`
- Modify: `docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
- Modify: `docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-plan.md`

**Step 1：写打包宿主集成测试入口**

安装固定开发依赖：

```powershell
npm install --save-dev @vscode/test-electron@3.0.0 @vscode/vsce@3.9.2
```

增加 scripts：

```json
"test:vscode:sqlite": "node scripts/run-sqlite-vscode-test.mjs",
"package:vscode": "vsce package --out dist/loopagent-vscode.vsix"
```

`run-sqlite-vscode-test.mjs` 使用 `@vscode/test-electron` 下载/运行明确版本 `1.101.0`，打开临时工作区，并执行编译后的 `sqliteCodeIndexExtension.test.js`。

集成测试通过 `vscode.commands.executeCommand("loopagent.showCodeIndexStatus")` 断言：

```ts
assert.equal(status.capabilities.sqlite, true);
assert.equal(status.capabilities.fts5, true);
assert.equal(status.capabilities.wal, true);
assert.equal(status.state, "ready");
```

随后创建两个函数文件、等待索引 ready、只修改一个函数，并断言 status metrics 中 `changedChunks === 1` 且 `embeddingsInvalidated <= 1`。删除文件后断言 persisted file/chunk count 下降。

**Step 2：运行最低版本测试确认 RED**

```powershell
npm run compile
npm run test:vscode:sqlite
```

Expected: 初次 FAIL，integration bundle 或 runner 尚未接入完整 build。

**Step 3：补齐 integration bundle 与验证报告骨架**

在 `esbuild.js` 增加 `test/integration/sqliteCodeIndexExtension.test.ts -> dist/test/sqliteCodeIndexExtension.test.js` 的 node22 CJS build entry，仅在非 production 或显式 integration build 时生成。

验证报告必须记录：

- VS Code 版本、Electron/Node 版本。
- DB 路径类别，不记录用户绝对路径。
- `node:sqlite`、FTS5、WAL、worker bundle 状态。
- cold start / warm restart 的 parsed files 数量。
- 单函数变化的 chunk write、FTS write、embedding invalidation 数量。
- 新增、删除、重命名、事务失败恢复结果。
- 自动化命令和唯一 Extension Development Host 真实验证结果。

**Step 4：执行最终自动化验证并确认 GREEN**

```powershell
npm ci
npm test
npm run typecheck
npm run compile
npm run test:vscode:sqlite
npm run package:vscode
git diff --check
```

Expected: 全部 exit code 0，VSIX 存在于 `dist/loopagent-vscode.vsix`，worker 和 Tree-sitter WASM 均包含在包中。

**Step 5：执行当前 VS Code 真实窗口验证**

```powershell
npm run debug:vscode
```

只复用一个 LoopAgent Extension Development Host：

1. 执行 `LoopAgent: Open Panel`。
2. 执行 `LoopAgent: Show Code Index Status`，确认 ready、WAL、FTS5。
3. 对同一工作区连续提问两次，第二次不重新解析未变化文件。
4. 保存只修改一个函数的文件，再提问并确认只有对应 chunk 更新。
5. 新增和删除测试文件，确认数据库计数与检索结果同步。
6. 执行 rebuild 和 clear，确认 worker/数据库生命周期正确且没有第二个调试窗口。

将实际结果写入验证报告，不写 API key 或源码 chunk 全文。

**Step 6：更新规格状态和计划完成记录**

设计文档状态改为“已实现并验证”，计划各任务记录实际提交和偏差。若实际实现方向变化，先修正文档再完成任务。

**Step 7：提交验证与文档**

```powershell
git add package.json package-lock.json esbuild.js scripts/run-sqlite-vscode-test.mjs test/integration/sqliteCodeIndexExtension.test.ts docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-plan.md docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-verification.md
git diff --cached --check
git commit -m "test(intelligence): verify persistent sqlite code index"
```

## 最终验收清单

- [ ] SQLite 数据库位于 `context.storageUri`，仓库中没有数据库、WAL 或 SHM 文件。
- [ ] VS Code `1.101.0` 和当前版本都能在 Extension Host 中加载 `node:sqlite`、FTS5 和 worker。
- [ ] 扩展重启后未变化文件不重新 parser/chunker。
- [ ] 单函数内容变化只更新对应 chunk、出边、FTS 和 embedding 状态。
- [ ] 纯行号移动不更新 FTS 或 embedding。
- [ ] 新增、删除、重命名后没有旧 chunk、孤立边或错误 FTS hit。
- [ ] 事务失败后查询读取完整旧版本，重启后 job 能恢复。
- [ ] exact token、FTS、graph 在没有 embedding provider 时可独立工作。
- [ ] Extension Host 不保留完整仓库 source/extraction/graph/search Map。
- [ ] 排除和敏感文件没有写入任一 SQLite 表。
- [ ] rebuild、clear、status 和 embedding key 命令通过自动化及真实宿主验证。
- [ ] `npm ci`、全量测试、typecheck、compile、最低版本 integration test、VSIX 打包和 `git diff --check` 全部通过。
- [ ] 清理无消费者旧代码、过期测试、临时脚本和不一致文档。
