# 工作区增量索引实施计划

> **Agent 执行要求：** 在既有 SQLite feature worktree 中执行，选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。逐任务 RED -> GREEN -> REFACTOR。

**目标：** 将启动扫描和 VS Code watcher 统一接入持久化 job 队列，在读取前执行敏感路径最终门禁，并只重算真正受影响的文件和跨文件关系。

**架构：** VS Code adapter 只负责列举、stat、读取和 watcher；`WorkspaceIndexer` 负责路径策略、hash、parse/extract/snapshot/job；SQLite worker 负责持久化和关系证据。

**技术栈：** TypeScript、VS Code Workspace API、web-tree-sitter、SQLite worker RPC、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-workspace-incremental-design.md`

**前置门禁：** 存储/worker 与 chunk/snapshot 两份计划全部完成。

---

## 文件职责

- `workspaceFilePolicy.ts`：扫描、watcher、job 共用的纯路径策略。
- `workspaceIndexer.ts`：启动对账、job 处理、tree 生命周期和 drain/dispose。
- `vscodeWorkspaceIntelligence.ts`：VS Code API 适配，不保存仓库级 Map/Set。
- `sqliteReferenceResolver.ts`：只使用持久化证据的跨文件关系解析。

## Task 1：抽取共享敏感路径策略

**Files:**

- Create: `src/extension/intelligence/indexing/workspaceFilePolicy.ts`
- Create: `test/intelligence/workspaceFilePolicy.test.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/intelligence/vscodeWorkspaceIntelligence.test.ts`

- [ ] **Step 1：写跨平台路径策略失败测试**

```ts
it.each([
  ["src/extension.ts", true],
  ["node_modules/react/index.js", false],
  ["dist/extension.js", false],
  [".git/config", false],
  [".local-vscode-user-data/User/settings.json", false],
  [".env.local", false],
  ["secrets/api-token.ts", false],
  ["config/api_key.py", false],
  ["src\\model\\provider.ts", true],
])("classifies %s", (filePath, expected) => {
  expect(isIndexableWorkspacePath(filePath)).toBe(expected);
});
```

另测 `detectWorkspaceLanguageId` 只接受 TS/TSX/JS/JSX/Python。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/workspaceFilePolicy.test.ts
```

Expected: FAIL，共享策略模块不存在。

- [ ] **Step 3：实现纯函数策略并迁移现有调用**

```ts
export function normalizeWorkspaceRelativePath(filePath: string, workspaceRoots: readonly string[]): string;
export function isIndexableWorkspacePath(filePath: string): boolean;
export function detectWorkspaceLanguageId(filePath: string): string | undefined;
```

路径统一 `/`，规则逐项实现设计规格；不读取磁盘、不访问 VS Code global。把 `vscodeWorkspaceIntelligence.ts` 现有同名逻辑迁入该模块并 re-export 仅在兼容测试确有需要时保留。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/workspaceFilePolicy.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/workspaceFilePolicy.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/workspaceFilePolicy.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts
git diff --cached --check
git commit -m "refactor(intelligence): share workspace file policy"
```

## Task 2：实现启动对账和 WorkspaceIndexer

**Files:**

- Create: `src/extension/intelligence/indexing/workspaceIndexer.ts`
- Create: `test/intelligence/workspaceIndexer.test.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `test/mocks/vscode.ts`

- [ ] **Step 1：写重启复用、hash 对账和版本变化失败测试**

```ts
it("skips parser and chunker for unchanged persisted files after restart", async () => {
  const fixture = unchangedFileFixture({ mtime: 10, size: 100, contentHash: "same" });
  await fixture.indexer.scanWorkspace();
  expect(fixture.readFile).not.toHaveBeenCalled();
  expect(fixture.parserRuntime.parse).not.toHaveBeenCalled();
  expect(fixture.store.applyFileSnapshot).not.toHaveBeenCalled();
});

it("reads but does not parse when metadata changes and content hash is equal", async () => {
  const fixture = metadataOnlyFixture();
  await fixture.indexer.scanWorkspace();
  expect(fixture.readFile).toHaveBeenCalledOnce();
  expect(fixture.parserRuntime.parse).not.toHaveBeenCalled();
  expect(fixture.store.updateFileMetadata).toHaveBeenCalledOnce();
});

it("queues unchanged content when extractor version changes", async () => {
  const fixture = versionChangedFixture({ storedExtractor: 1, currentExtractor: 2 });
  await fixture.indexer.scanWorkspace();
  expect(fixture.store.enqueueChanges).toHaveBeenCalledWith([
    expect.objectContaining({ eventKind: "change" }),
  ]);
});
```

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts
```

Expected: FAIL，WorkspaceIndexer 不存在。

- [ ] **Step 3：实现扫描依赖边界和 URI 对账**

```ts
export type WorkspaceFileRef = {
  uri: string;
  relativePath: string;
  languageId: string;
};

export type WorkspaceIndexer = {
  scanWorkspace(): Promise<void>;
  processNextJob(): Promise<boolean>;
  drain(options?: { timeoutMs?: number }): Promise<void>;
  dispose(): Promise<void>;
};
```

扫描只处理 writer：列允许路径、比较 URI 集合、先 size/mtime/version，再按需 read/hash。新增/删除/内容或版本变化写入同一 `index_jobs`；hash 相同只更新 metadata。

store/RPC 在本任务增加 `listStoredFiles`、`updateFileMetadata` 和批量 `enqueueChanges`。全部返回有界文件 metadata DTO，不返回 chunk 或源码。

- [ ] **Step 4：接入 VS Code stat/list/read adapter 并确认 GREEN**

扩展 `VsCodeWorkspaceApi.workspace.fs.stat` mock。`createVsCodeWorkspaceIntelligence` 提供 list/stat/read 依赖，不创建 source cache。运行：

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts
npm run typecheck
```

Expected: 全部通过，重启复用测试不调用 read/parser。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/workspaceIndexer.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/workspaceIndexer.test.ts test/mocks/vscode.ts
git diff --cached --check
git commit -m "feat(intelligence): reconcile workspace index files"
```

## Task 3：处理持久化 Job 并执行读取前最终门禁

**Files:**

- Modify: `src/extension/intelligence/indexing/workspaceIndexer.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `test/intelligence/workspaceIndexer.test.ts`

- [ ] **Step 1：写 changed/delete、敏感 job 和失败保留旧版测试**

```ts
it("rejects an excluded queued path before stat or read", async () => {
  const fixture = queuedJobFixture({ fileUri: "file:///workspace/.env.local" });
  await fixture.indexer.processNextJob();
  expect(fixture.statFile).not.toHaveBeenCalled();
  expect(fixture.readFile).not.toHaveBeenCalled();
  expect(fixture.parserRuntime.parse).not.toHaveBeenCalled();
  expect(fixture.store.removeExcludedFileAndJob).toHaveBeenCalledOnce();
});

it("parses, snapshots, persists, and releases one changed file", async () => {
  const fixture = changedFileJobFixture();
  await fixture.indexer.processNextJob();
  expect(fixture.parserRuntime.parse).toHaveBeenCalledOnce();
  expect(fixture.store.applyFileSnapshot).toHaveBeenCalledOnce();
  expect(fixture.tree.delete).toHaveBeenCalledOnce();
  expect(fixture.store.completeJob).toHaveBeenCalledOnce();
});
```

另测 parser/snapshot 失败保留旧数据库、记录诊断、fail job；stat 后文件消失按 delete。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts
```

Expected: FAIL，job 处理尚未实现完整链路。

- [ ] **Step 3：实现 job pipeline**

顺序必须是 claim -> policy -> stat -> read/hash -> parse/extract/chunk -> apply snapshot -> resolve impacted -> complete。tree 在 `finally` 中 delete；job completion 使用 claim token，不能删除处理中到达的新 pending 事件。

excluded job 通过单个 RPC 删除历史 file 数据和 job，不读取源码。失败只 fail 当前 job，不清除上一版 ready snapshot。

该 RPC 命名为 `removeExcludedFileAndJob`，在一个 lease-guarded transaction 中删除 file 级联数据和对应 job；不存在历史 file 时仍删除 job并返回零计数。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/workspaceIndexer.test.ts test/intelligence/workspaceAstIntegration.test.ts test/intelligence/sqliteSnapshotStore.test.ts
npm run typecheck
```

Expected: 全部通过，安全门禁断言 stat/read/parse 调用数均为 0。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/indexing/workspaceIndexer.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/workspaceIndexer.test.ts
git diff --cached --check
git commit -m "feat(intelligence): process persistent workspace jobs"
```

## Task 4：把 Watcher 事件写入持久化队列

**Files:**

- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `test/intelligence/vscodeWorkspaceIntelligence.test.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`

- [ ] **Step 1：写 watcher 安全过滤、持久化和 dispose 失败测试**

```ts
it("persists allowed events and ignores excluded paths", async () => {
  const fixture = createWatcherFixture();
  fixture.watcher.fireCreate(uri("src/new.ts"));
  fixture.watcher.fireChange(uri(".env.local"));
  fixture.watcher.fireDelete(uri("src/old.ts"));
  expect(fixture.store.enqueueChanges).toHaveBeenNthCalledWith(1, [
    expect.objectContaining({ eventKind: "create" }),
  ]);
  expect(fixture.store.enqueueChanges).toHaveBeenNthCalledWith(2, [
    expect.objectContaining({ eventKind: "delete" }),
  ]);
});
```

dispose 测试断言 watcher -> indexer -> worker 的调用顺序，并且 handler 在 dispose 后不入队。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts
```

Expected: FAIL，当前实现仍维护 Map/Set，且没有异步 dispose。

- [ ] **Step 3：实现持久化 watcher 和生命周期**

初始化完成且 role=writer 后注册唯一 watcher。handler 只规范化、policy、enqueue。删除 `sourceCache`、`dirtyPaths`、`deletedPaths` 的 watcher 读写职责。旧 prompt 的同步 `readSourceRange` 迁移 shim 可以暂时保留现有请求所需源码，但 watcher 不更新它；检索计划 Task 4 切换到 SQLite DTO 后必须删除该 shim，不能尝试用异步 `workspace.fs.readFile` 实现同步接口。

`WorkspaceIntelligence` 增加 `dispose(): Promise<void>`。read_only 不注册写 watcher；接管 lease 后 scan 完成再注册。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts test/intelligence/workspaceIndexer.test.ts
npm run typecheck
```

Expected: 全部通过，敏感 watcher 事件不入队。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/vscodeWorkspaceIntelligence.ts src/extension/intelligence/workspaceIntelligence.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/extensionWorkspaceIntelligence.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist workspace file events"
```

## Task 5：持久化依赖关系并有界重解析

**Files:**

- Create: `src/extension/intelligence/resolution/sqliteReferenceResolver.ts`
- Create: `test/intelligence/sqliteReferenceResolver.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-workspace-incremental-design.md`

- [ ] **Step 1：写导出变化、删除和循环依赖失败测试**

```ts
it("re-resolves dependent edges without parsing dependent source", async () => {
  const fixture = createPersistedImportedCallFixture();
  fixture.store.applyFileSnapshot(exporterRenamedSnapshot());
  const result = fixture.store.resolveImpactedDependencies("file:src/exporter.ts");
  expect(result.impactedFileIds).toEqual(["file:src/consumer.ts"]);
  expect(result.removedEdgeIds).toContain("edge:consumer:calls:oldExport");
  expect(fixture.parserRuntime.parse).not.toHaveBeenCalled();
});
```

另测删除 exporter 后依赖变 unresolved、循环依赖去重、maxFiles 上限截断。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteReferenceResolver.test.ts
```

Expected: FAIL，SQLite resolver 不存在。

- [ ] **Step 3：实现纯解析函数和 store adapter**

```ts
export function resolvePersistedReferences(input: {
  changedFileId: string;
  nodes: readonly SnapshotNode[];
  bindings: readonly SnapshotImportBinding[];
  references: readonly SnapshotReference[];
  dependencies: readonly FileDependency[];
  maxFiles: number;
}): PersistedResolutionResult;

export type PersistedResolutionResult = {
  impactedFileIds: string[];
  removedEdgeIds: string[];
  upsertedEdges: SnapshotEdge[];
  unresolvedReferences: SnapshotReference[];
  truncated: boolean;
};
```

store 按 `file_dependencies.to_file_id` 加载有界证据，在事务内替换 impacted edge/unresolved rows，不读源码、不调用 parser。

- [ ] **Step 4：运行阶段全量验证**

```powershell
npm test -- test/intelligence/workspaceFilePolicy.test.ts test/intelligence/workspaceIndexer.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/intelligence/sqliteReferenceResolver.test.ts test/intelligence/referenceResolver.test.ts test/intelligence/modulePathResolver.test.ts test/extensionWorkspaceIntelligence.test.ts
npm run typecheck
npm run compile
git diff --check
```

Expected: 全部通过；scan/watcher/job 安全测试都证明敏感文件未被读取。

- [ ] **Step 5：更新规格状态并提交**

把 workspace 增量规格状态改为“已实现，等待总体验证”。提交：

```powershell
git add src/extension/intelligence/resolution/sqliteReferenceResolver.ts src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteReferenceResolver.test.ts docs/superpowers/specs/2026-07-11-sqlite-index-workspace-incremental-design.md
git diff --cached --check
git commit -m "feat(intelligence): resolve persisted code references"
```

## 计划完成记录

记录冷/暖扫描读文件数、parser 次数、敏感路径三条门禁结果、删除/重命名结果、依赖重解析上限、实际提交、偏差和技术债。完成 Task 1-5 后才能进入检索与上下文计划。
