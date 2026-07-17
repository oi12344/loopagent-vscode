# 工作区持久化增量索引最小实施计划

> **Agent 执行要求：** 使用 `superpowers:executing-plans` 在当前 checkout、当前分支逐任务执行。每个任务按 RED -> GREEN -> REFACTOR 完成，步骤使用复选框（`- [ ]`）跟踪。

**目标：** 扩展启动后把允许索引的工作区文件及 create/change/delete 事件持续写入 SQLite，重启时跳过未变化文件，并在失败或关闭时保护旧 snapshot 与资源。

**架构：** 新增无 VS Code 依赖的 `WorkspaceIndexer`，复用现有 parser、language adapter、snapshot builder 和 SQLite worker client。现有唯一 watcher 同时负责内存缓存失效和持久化入队；模型读取链路本轮仍使用内存索引。

**技术栈：** TypeScript、VS Code Workspace API、Tree-sitter、`node:sqlite` worker、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-14-sqlite-index-workspace-minimal-design.md`

## 全局约束

- 直接在当前 `main` 开发，不创建 worktree。
- 不新增依赖、设置项、命令、UI、repository 层或第二套 job 抽象。
- 数据库固定为 `context.storageUri/index/code-index.sqlite`；无 `storageUri` 时只保留内存索引和现有 watcher。
- 扫描、watcher、job 执行共用同一敏感路径策略；job 读取前必须再次检查。
- 只有 writer 扫描和处理 job；本阶段不实现 read-only 后续接管。
- 单实例只能有一个 drain；Tree-sitter tree 在 `finally` 中释放一次。
- 删除必须在事务中显式清理 `chunk_fts` 后删除 file；解析失败不得覆盖旧 snapshot。
- 固定 `EXTRACTOR_VERSION = 1`、`CHUNKER_VERSION = 1`、关闭等待上限 5 秒，不增加配置入口。
- 本轮最多新增一个核心测试文件，并复用现有存储、VS Code 和扩展测试文件。

---

## Task 1：打通真实 SQLite 增量写入闭环

**Files:**

- Create: `src/extension/intelligence/indexing/workspaceFilePolicy.ts`
- Create: `src/extension/intelligence/indexing/workspaceIndexer.ts`
- Create: `test/intelligence/workspaceIndexer.test.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerRuntime.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `test/intelligence/sqliteSnapshotStore.test.ts`

**Interfaces:**

```ts
export type StoredFileMetadata = {
  uri: string;
  contentHash: string;
  byteLength: number;
  mtime: number;
  extractorVersion: number;
  chunkerVersion: number;
};

export type FileMetadataUpdate = Omit<StoredFileMetadata, "contentHash">;

export type WorkspaceFileRef = {
  uri: string;
  path: string;
  languageId: string;
  mtime: number;
  byteLength: number;
};

export type WorkspaceIndexer = {
  start(): Promise<void>;
  enqueue(change: IndexChange): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
};
```

`SqliteIndexStore` 增加：

```ts
listIndexedFiles(): StoredFileMetadata[];
updateFileMetadata(ownerId: string, update: FileMetadataUpdate): void;
removeFile(ownerId: string, fileUri: string): void;
```

worker runtime/client 增加无 `ownerId` 的 `listIndexedFiles()`、`updateFileMetadata(update)` 和 `removeFile(fileUri)`；runtime 使用当前 writer owner。

- [x] **Step 1：写整体 RED 测试**

在 `workspaceIndexer.test.ts` 使用临时真实 SQLite、真实 `SqliteIndexStore` 和内存文件系统。一个主测试依次执行：首次 `start()` 后存在 file/symbol card；change 后只出现新符号；delete 后 file/chunk/FTS 均为零；用同一数据库重启时 parser 调用数为零。

```ts
const indexer = createWorkspaceIndexer({
  ownerId: "owner-a", store, parserRuntime, maxFileBytes: 100_000,
  listFiles: async () => [...files.values()].map(toRef),
  statFile: async (uri) => files.get(uri)?.ref,
  readFile: async (uri) => files.get(uri)!.text,
});
await indexer.start();
expect(cards(database)).toEqual(expect.arrayContaining(["src/sample.ts", "run"]));
files.set(uri, source("export function renamed() {}", 2_000));
await indexer.enqueue({ fileUri: uri, eventKind: "change" });
expect(cards(database)).toContain("renamed");
files.delete(uri);
await indexer.enqueue({ fileUri: uri, eventKind: "delete" });
expect(fileFacts(database, uri)).toEqual({ files: 0, chunks: 0, fts: 0 });
```

在 `sqliteSnapshotStore.test.ts` 增加一个删除事务断言：`removeFile` 后 file/chunk/node/FTS 全部为零；无 writer lease 时删除抛错且数据不变。

- [x] **Step 2：运行确认 RED**

Run:

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts test/intelligence/sqliteSnapshotStore.test.ts --reporter=dot
```

Expected: FAIL，`createWorkspaceIndexer`、文件元数据方法和共享路径策略尚不存在。

- [x] **Step 3：实现最小存储生命周期**

在 `sqliteIndexStore.ts` 用结构化查询实现三项能力：

```sql
SELECT uri, content_hash, byte_length, mtime, extractor_ver, chunker_ver
FROM files WHERE index_state = 'ready' ORDER BY uri;

UPDATE files SET mtime = ?, byte_length = ?, extractor_ver = ?, chunker_ver = ?
WHERE uri = ?;

DELETE FROM chunk_fts
WHERE chunk_id IN (SELECT chunks.id FROM chunks JOIN files ON files.id = chunks.file_id WHERE files.uri = ?);
DELETE FROM files WHERE uri = ?;
```

更新和删除必须调用 `assertWriterLease` 并包在现有 `transaction` 中。随后把方法逐层接入 `SqliteWorkerStore`、runtime、protocol、worker dispatch 和 client；不新增通用请求包装。

- [x] **Step 4：抽取共享路径策略并实现 WorkspaceIndexer**

把 `isIndexableWorkspacePath`、`detectWorkspaceLanguageId` 和分隔符规范化迁到 `workspaceFilePolicy.ts`，`vscodeWorkspaceIntelligence.ts` 仅 re-export 兼容现有调用。

`createWorkspaceIndexer` 的固定流程：

```text
start: writer check -> list files + stored metadata -> enqueue create/change/delete -> drain
enqueue: disposed guard -> store.enqueueChanges -> drain
drain: reuse one promise -> claim until empty -> process current filesystem state
process: second policy -> stat -> missing/remove -> read/hash -> unchanged/update metadata
         -> parse/extract/build snapshot/apply/update metadata -> complete
error: fail claimed job; never replace old snapshot
finally: parsed.tree?.delete()
```

使用现有 `createTypeScriptAdapter()`、`createPythonAdapter()`、`buildExtractionSnapshot()` 和 Node `createHash("sha256")`。事件 job 只保存 URI；`statFile` 负责恢复当前 path/language/mtime/size。`drainPromise` 在 `finally` 清空，禁止并行 claim。

- [x] **Step 5：运行整体 GREEN 并提交**

Run:

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts test/intelligence/sqliteSnapshotStore.test.ts test/intelligence/sqliteIndexJobs.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts --reporter=dot
npm run typecheck
git diff --check
```

Expected: 整体写入、变化、删除、重启复用通过；既有 job/client 回归全绿。

Commit:

```powershell
git add src/extension/intelligence/indexing src/extension/intelligence/storage src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/workspaceIndexer.test.ts test/intelligence/sqliteSnapshotStore.test.ts
git commit -m "feat(intelligence): persist workspace changes"
```

## Task 2：接入唯一 VS Code watcher 与扩展生命周期

**Files:**

- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension.ts`
- Modify: `test/intelligence/workspaceIndexer.test.ts`
- Modify: `test/intelligence/vscodeWorkspaceIntelligence.test.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`
- Modify: `docs/superpowers/specs/2026-07-14-sqlite-index-workspace-minimal-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-sqlite-index-workspace-minimal-plan.md`

**Interfaces:**

`createVsCodeWorkspaceIntelligence` 返回：

```ts
WorkspaceIntelligence & { dispose(): Promise<void> };
```

`CreateVsCodeWorkspaceIntelligenceOptions` 增加：

```ts
storageUri?: WorkspaceUri;
createIndexClient?: () => SqliteIndexWorkerClient;
```

测试通过 `createIndexClient` 注入 fake client；生产默认使用：

```ts
new Worker(join(__dirname, "sqliteIndexWorker.js"));
createSqliteIndexWorkerClient({ worker });
```

- [x] **Step 1：写生产接线 RED 测试**

在 `vscodeWorkspaceIntelligence.test.ts` 扩展现有 fake VS Code API，加入 `fs.stat`、`Uri.parse`、`storageUri` 和 fake index client。验证初始化路径、watcher 入队、单次 watcher/client dispose；另测无 `storageUri` 时不创建 client，但 watcher change 后内存查询仍读取新内容。

```ts
const intelligence = createVsCodeWorkspaceIntelligence(vscodeApi, {
  parserRuntime, storageUri: { fsPath: "E:\\storage" }, createIndexClient: () => client,
});
await eventually(() => expect(client.initialize).toHaveBeenCalledWith(
  "E:\\storage\\index\\code-index.sqlite", expect.any(String),
));
watcher.fireChange(sourceUri);
await eventually(() => expect(client.enqueueChanges).toHaveBeenCalled());
await intelligence.dispose();
expect(watcher.dispose).toHaveBeenCalledTimes(1);
expect(client.dispose).toHaveBeenCalledTimes(1);
```

在 `extensionWorkspaceIntelligence.test.ts` 断言 factory 收到 `context.storageUri`，且 `deactivate()` 等待 `workspaceIntelligence.dispose()`。

- [x] **Step 2：运行确认 RED**

Run:

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts --reporter=dot
```

Expected: FAIL，当前接口没有 `storageUri`、client 初始化和 dispose 接线。

- [x] **Step 3：实现单 watcher 生产接线**

`createVsCodeWorkspaceIntelligence` 保留现有 watcher。每个 handler 先更新内存 cache 状态，再在持久化 indexer 已成为 writer 时异步入队；错误写入现有 diagnostics，不产生未处理 rejection。

有 `storageUri` 时创建目录、worker client 和 owner UUID，初始化成功且角色为 writer 后创建 `WorkspaceIndexer` 并 `start()`。无 `storageUri` 或角色为 read-only 时不启动持久化分支。

返回对象的 `dispose()` 只执行一次：dispose watcher，等待 indexer 最多 5 秒，再 dispose client。通用 `WorkspaceIntelligence` 接口和内存实现不增加生命周期方法。

`extension.ts` 在 provider constructor 中创建实例并传入 `context.storageUri`；模块保存当前 provider，`deactivate(): Promise<void>` 取消 active run 并等待 workspace intelligence 关闭。

- [x] **Step 4：补危险边界回归并运行阶段验证**

在 `workspaceIndexer.test.ts` 用同一 fixture 增加四个用例：

1. 扫描、enqueue、job 二次门禁均不调用敏感文件 `readFile`。
2. mtime/size 变化但 SHA-256 相同，只更新 metadata，不调用 parser。
3. parser 抛错后旧 card 仍存在且 job 为 `failed`。
4. dispose 后 enqueue 拒绝，当前 tree 恰好 delete 一次。

Run:

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts --reporter=dot
npm test -- --reporter=dot
npm run typecheck
npm run compile
git diff --check
```

Expected: 全部测试、类型检查、构建和 diff 检查通过；无第二个 watcher、无未处理 promise、无临时调试代码。

- [x] **Step 5：更新文档状态并提交**

在设计和本计划末尾记录中文验证结果：测试文件/用例数、重启 parser 调用数、删除后的残留计数、实际提交和已知限制。只保留“跨文件关系重算、SQLite 检索、embedding、管理命令”作为后续范围。

Commit:

```powershell
git add src/extension.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/workspaceIndexer.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts docs/superpowers/specs/2026-07-14-sqlite-index-workspace-minimal-design.md docs/superpowers/plans/2026-07-14-sqlite-index-workspace-minimal-plan.md
git commit -m "feat(intelligence): start persistent workspace index"
```

## 完成记录

2026-07-14 完成：Task 1 和 Task 2 均按 RED -> GREEN 执行；全量验证为 49 个测试文件、259 个用例，类型检查和构建通过。实际实现未增加跨文件关系重算、SQLite 检索、embedding 或管理命令；持久化 worker 的真实 VS Code 宿主验证留给后续生命周期阶段。
