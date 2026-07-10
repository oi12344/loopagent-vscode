# SQLite 存储与 Worker 实施计划

> **Agent 执行要求：** 先使用 `superpowers:using-git-worktrees` 确认独立 worktree，再选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。逐任务执行复选框，每个任务严格 RED -> GREEN -> REFACTOR。

**目标：** 建立已在最低 VS Code 宿主验证的 Node 22 SQLite worker、version 1 schema、类型化 RPC、持久化 job 和完整 writer lease 状态机。

**架构：** Extension Host 只持有异步 client，`DatabaseSync` 只存在于独立 worker。最小真实宿主探针在 schema 工作前执行；SQLite migration、job 和 lease 都由 worker 串行处理。

**技术栈：** TypeScript、Node 22 `node:sqlite`、`worker_threads`、SQLite WAL/FTS5、Vitest、esbuild、`@vscode/test-electron`。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-storage-worker-design.md`

**前置条件：** 总实施计划的 worktree 基线通过。本计划不依赖其他 SQLite 子计划。

---

## 文件职责

- `sqliteCapabilities.ts`：同步探测 SQLite/WAL/foreign key/FTS5，只在 worker 或测试进程调用。
- `indexSchema.ts`：version 1 DDL 的唯一代码定义。
- `indexMigrations.ts`：单调 migration 和 `user_version`。
- `indexDatabase.ts`：打开、PRAGMA、备份不兼容数据库、checkpoint 和关闭。
- `sqliteIndexWorkerProtocol.ts`：所有可结构化克隆的 request/response DTO。
- `sqliteIndexWorker.ts`：worker entry、串行 dispatch、连接和 lease 生命周期。
- `sqliteIndexWorkerClient.ts`：Extension Host 异步 RPC client，不暴露 SQL。
- `sqliteIndexStore.ts`：worker 内 schema 级 store、job 和 lease 原语。
- `run-sqlite-vscode-probe.mjs`：固定最低版本 Extension Host 探针入口。

## Task 1：提升运行时基线并实现 SQLite 能力探针

**Files:**

- Create: `src/extension/intelligence/storage/sqliteCapabilities.ts`
- Create: `test/intelligence/sqliteCapabilities.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/packageManifest.test.ts`
- Modify: `esbuild.js`

- [ ] **Step 1：写 manifest 和 capability 失败测试**

在 `test/packageManifest.test.ts` 增加：

```ts
it("requires the VS Code Node 22 sqlite baseline", () => {
  expect(manifest.engines.vscode).toBe("^1.101.0");
  expect(manifest.devDependencies["@types/vscode"]).toBe("^1.101.0");
});
```

新建 `test/intelligence/sqliteCapabilities.test.ts`，使用 `try/finally` 删除临时目录：

```ts
it("probes sqlite, WAL, foreign keys, and FTS5", () => {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-sqlite-"));
  try {
    expect(probeSqliteCapabilities(join(directory, "probe.sqlite"))).toEqual({
      sqlite: true,
      wal: true,
      foreignKeys: true,
      fts5: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2：运行测试确认 RED**

```powershell
npm test -- test/packageManifest.test.ts test/intelligence/sqliteCapabilities.test.ts
```

Expected: FAIL，manifest 仍为 `^1.96.0`，且 `probeSqliteCapabilities` 不存在。

- [ ] **Step 3：实现最小 capability probe**

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

实现必须打开 `DatabaseSync`，执行并验证：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE VIRTUAL TABLE __loopagent_fts_probe USING fts5(text);
DROP TABLE __loopagent_fts_probe;
```

在 `finally` 中关闭数据库。修改：

```text
package.json engines.vscode                   -> ^1.101.0
package.json devDependencies.@types/vscode    -> ^1.101.0
esbuild.js extensionConfig.target             -> node22
```

运行 `npm install --save-dev @types/vscode@^1.101.0` 更新 `package-lock.json`，不要手工编辑 lockfile。

- [ ] **Step 4：运行测试、类型检查和构建确认 GREEN**

```powershell
npm test -- test/packageManifest.test.ts test/intelligence/sqliteCapabilities.test.ts
npm run typecheck
npm run compile
```

Expected: 全部 exit code 0，`dist/extension.js` 正常生成。

- [ ] **Step 5：提交**

```powershell
git add package.json package-lock.json esbuild.js src/extension/intelligence/storage/sqliteCapabilities.ts test/packageManifest.test.ts test/intelligence/sqliteCapabilities.test.ts
git diff --cached --check
git commit -m "build: require vscode node sqlite runtime"
```

## Task 2：建立类型化 Worker RPC 和独立 Bundle

**Files:**

- Create: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Create: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Create: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Create: `test/intelligence/sqliteIndexWorkerClient.test.ts`
- Create: `test/sqliteWorkerBundle.test.ts`
- Modify: `esbuild.js`

- [ ] **Step 1：写 RPC 配对、错误和 dispose 失败测试**

```ts
it("matches typed responses and propagates worker errors", async () => {
  const worker = createFakeWorker();
  const client = createSqliteIndexWorkerClient({ worker });
  const pending = client.probe("E:/tmp/probe.sqlite");
  worker.respond({ id: worker.lastRequestId(), ok: false, error: "probe failed" });
  await expect(pending).rejects.toThrow("probe failed");
});

it("rejects every pending request when disposed", async () => {
  const worker = createFakeWorker();
  const client = createSqliteIndexWorkerClient({ worker });
  const pending = client.getStatus();
  await client.dispose();
  await expect(pending).rejects.toThrow(/disposed/i);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
```

`test/sqliteWorkerBundle.test.ts` 断言 worker target 为 `node22`、format 为 `cjs`、outfile 为 `dist/sqliteIndexWorker.js`。

- [ ] **Step 2：运行测试确认 RED**

```powershell
npm test -- test/intelligence/sqliteIndexWorkerClient.test.ts test/sqliteWorkerBundle.test.ts
```

Expected: FAIL，协议、client、worker entry 和 bundle config 不存在。

- [ ] **Step 3：实现基础协议和 client**

协议从以下联合开始：

```ts
export type SqliteWorkerRequest =
  | { id: number; kind: "probe"; databasePath: string }
  | { id: number; kind: "getStatus" }
  | { id: number; kind: "dispose" };

export type SqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
```

client 使用递增 request ID 和 `Map<number, PendingRequest>`。`error`、非零 `exit` 和 dispose 都拒绝全部 pending；生产 API 不接受 SQL 字符串。

- [ ] **Step 4：实现 worker bundle 并确认 GREEN**

在 `esbuild.js` 增加独立 config，并让 build/watch 都处理三个 bundle：

```js
const sqliteWorkerConfig = {
  ...extensionConfig,
  entryPoints: ["src/extension/intelligence/storage/sqliteIndexWorker.ts"],
  outfile: "dist/sqliteIndexWorker.js",
};
```

运行：

```powershell
npm test -- test/intelligence/sqliteIndexWorkerClient.test.ts test/sqliteWorkerBundle.test.ts
npm run typecheck
npm run compile
Test-Path dist/sqliteIndexWorker.js
```

Expected: 测试和构建通过，最后输出 `True`。

- [ ] **Step 5：提交**

```powershell
git add esbuild.js src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteIndexWorkerClient.test.ts test/sqliteWorkerBundle.test.ts
git diff --cached --check
git commit -m "feat(intelligence): add sqlite index worker rpc"
```

## Task 3：在最低 VS Code Extension Host 中验证 Worker 能力

**Files:**

- Create: `scripts/run-sqlite-vscode-probe.mjs`
- Create: `test/integration/sqliteCapabilityExtension.test.ts`
- Create: `test/fixtures/sqlite-probe/.gitkeep`
- Modify: `package.json`
- Modify: `esbuild.js`

- [ ] **Step 1：写 Extension Host probe runner**

`run-sqlite-vscode-probe.mjs` 使用现有 `@vscode/test-electron`：

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await runTests({
  version: "1.101.0",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "dist/test/sqliteCapabilityExtension.test.js"),
  launchArgs: [path.join(root, "test/fixtures/sqlite-probe"), "--disable-extensions"],
});
```

integration entry 导出 `async function run(): Promise<void>`，创建临时数据库，通过真实 `Worker` 加载 `dist/sqliteIndexWorker.js`，发送 `probe`，断言四项 capability 都为 true，最后 dispose worker 并删除临时目录。

- [ ] **Step 2：运行确认 RED**

```powershell
npm run compile
node scripts/run-sqlite-vscode-probe.mjs
```

Expected: FAIL，integration bundle 和 npm script 尚未接入。

- [ ] **Step 3：接入 integration bundle 和 script**

在 `package.json` 增加：

```json
"test:vscode:sqlite-probe": "node scripts/run-sqlite-vscode-probe.mjs"
```

在 `esbuild.js` 增加 Node 22 CJS test entry：

```js
const sqliteProbeTestConfig = {
  ...extensionConfig,
  entryPoints: ["test/integration/sqliteCapabilityExtension.test.ts"],
  outfile: "dist/test/sqliteCapabilityExtension.test.js",
  external: ["vscode"],
};
```

只在普通测试构建生成该 entry；production VSIX 不包含 integration test。

- [ ] **Step 4：运行最低宿主确认 GREEN**

```powershell
npm run compile
npm run test:vscode:sqlite-probe
```

Expected: exit code 0；报告 VS Code `1.101.0` 的 Node 版本，以及 sqlite/WAL/foreignKeys/FTS5 全部为 true。失败时停止本计划，不继续 schema 实现。

- [ ] **Step 5：提交**

```powershell
git add package.json esbuild.js scripts/run-sqlite-vscode-probe.mjs test/integration/sqliteCapabilityExtension.test.ts test/fixtures/sqlite-probe/.gitkeep
git diff --cached --check
git commit -m "test(intelligence): verify sqlite worker in minimum vscode host"
```

## Task 4：实现 Version 1 Schema 和 Migration

**Files:**

- Create: `src/extension/intelligence/storage/indexTypes.ts`
- Create: `src/extension/intelligence/storage/indexSchema.ts`
- Create: `src/extension/intelligence/storage/indexMigrations.ts`
- Create: `src/extension/intelligence/storage/indexDatabase.ts`
- Create: `test/intelligence/indexMigrations.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [ ] **Step 1：写完整结构、幂等和备份失败测试**

测试必须使用 `PRAGMA table_info`、`foreign_key_list`、`index_list`，断言规格中的 14 个命名数据库对象（含 `chunk_fts`）、必需列、foreign key action 和索引。另加：

```ts
it("is idempotent and rejects a newer schema", () => {
  const database = openTestDatabase();
  applyIndexMigrations(database);
  applyIndexMigrations(database);
  database.exec("PRAGMA user_version = 999");
  expect(() => applyIndexMigrations(database)).toThrow(/newer schema version/i);
});

it("backs up an incompatible database before rebuilding", () => {
  const databasePath = createDatabaseWithVersion(999);
  const result = openIndexDatabase(databasePath, { now: () => 12345 });
  expect(result.backupPath).toBe(`${databasePath}.backup-12345`);
  expect(result.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
});
```

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/indexMigrations.test.ts
```

Expected: FAIL，schema、migration 和 database opener 不存在。

- [ ] **Step 3：实现精确 schema 和 migration**

`indexTypes.ts` 在本任务先定义以下四个联合类型：

```ts
export type IndexJobEvent = "create" | "change" | "delete";
export type IndexJobStatus = "pending" | "running" | "failed";
export type FileIndexState = "pending" | "indexing" | "ready" | "failed" | "deleted";
export type EmbeddingStatus = "pending" | "ready" | "failed";
```

`indexSchema.ts` 必须逐字段实现存储规格的 version 1 schema、FTS、foreign key 和全部必需索引。`indexMigrations.ts` 导出：

```ts
export const CURRENT_INDEX_SCHEMA_VERSION = 1;
export function applyIndexMigrations(database: DatabaseSync): void;
```

`indexDatabase.ts` 负责 PRAGMA、unknown schema 备份主库/WAL/SHM、checkpoint 和 close；权限/I/O 错误原样抛出。

- [ ] **Step 4：把 initialize 加入 RPC 并确认 GREEN**

协议增加：

```ts
| { id: number; kind: "initialize"; databasePath: string; ownerId: string }
```

worker initialize 执行 capability probe、open、PRAGMA、migration，并返回 schemaVersion/capabilities。运行：

```powershell
npm test -- test/intelligence/indexMigrations.test.ts test/intelligence/sqliteCapabilities.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/storage/indexTypes.ts src/extension/intelligence/storage/indexSchema.ts src/extension/intelligence/storage/indexMigrations.ts src/extension/intelligence/storage/indexDatabase.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/indexMigrations.test.ts
git diff --cached --check
git commit -m "feat(intelligence): add sqlite index schema"
```

## Task 5：实现可恢复持久化 Job 队列

**Files:**

- Create: `src/extension/intelligence/storage/sqliteIndexStore.ts`
- Create: `test/intelligence/sqliteIndexJobs.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`

- [ ] **Step 1：写合并、处理中再入队和恢复失败测试**

```ts
it("keeps a new event queued when it arrives during a running job", () => {
  const store = createTestStore();
  store.enqueueFileEvent("file:///src/a.ts", "change");
  const claimed = store.claimNextJob("owner-a")!;
  store.enqueueFileEvent("file:///src/a.ts", "delete");
  store.completeJob(claimed);
  expect(store.listPendingJobs()).toMatchObject([
    { fileUri: "file:///src/a.ts", eventKind: "delete", status: "pending" },
  ]);
});

it("recovers only stale running jobs", () => {
  const store = createTestStore({ now: () => 10_000 });
  store.insertRunningJob({ updatedAt: 1_000 });
  expect(store.recoverInterruptedJobs({ staleAfterMs: 5_000 })).toBe(1);
});
```

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteIndexJobs.test.ts
```

Expected: FAIL，store 和 job API 不存在。

- [ ] **Step 3：实现 store job API**

```ts
export type IndexChange = {
  fileUri: string;
  eventKind: IndexJobEvent;
};

export type ClaimedIndexJob = {
  id: number;
  fileUri: string;
  eventKind: IndexJobEvent;
  claimedAt: number;
};

export class SqliteIndexStore {
  enqueueFileEvent(fileUri: string, eventKind: IndexJobEvent): void;
  claimNextJob(ownerId: string): ClaimedIndexJob | undefined;
  completeJob(claim: ClaimedIndexJob): void;
  failJob(claim: ClaimedIndexJob, error: string): void;
  recoverInterruptedJobs(options: { staleAfterMs: number }): number;
}
```

所有方法只操作 version 1 的 `index_jobs` 表。claim 必须原子修改 pending -> running 并增加 attempts。completion 只删除仍匹配本次 claim 且状态为 running 的行；处理中发生的新 upsert 必须保留 pending。

`claimedAt` 使用 claim 事务写入的 `updated_at`；complete/fail 条件必须同时匹配 id、running 和 claimedAt。

- [ ] **Step 4：扩展 RPC 并确认 GREEN**

增加 `enqueueChanges`、`getPendingJobs`、`claimNextJob`、`completeJob`、`failJob` 的固定 DTO。运行：

```powershell
npm test -- test/intelligence/sqliteIndexJobs.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/storage/sqliteIndexStore.ts src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts test/intelligence/sqliteIndexJobs.test.ts
git diff --cached --check
git commit -m "feat(intelligence): persist sqlite index jobs"
```

## Task 6：实现 Writer Lease 数据库原语

**Files:**

- Create: `test/intelligence/sqliteWriterLease.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexStore.ts`

- [ ] **Step 1：写双实例互斥和过期接管失败测试**

使用两个 `DatabaseSync` 连接指向同一临时库：

```ts
it("allows at most one writer and permits takeover after expiry", () => {
  const clock = fakeClock(10_000);
  const { first, second } = createTwoStores(clock);
  expect(first.acquireWriterLease("owner-a", 30_000)).toBe(true);
  expect(second.acquireWriterLease("owner-b", 30_000)).toBe(false);
  clock.advance(30_001);
  expect(second.acquireWriterLease("owner-b", 30_000)).toBe(true);
  expect(first.renewWriterLease("owner-a", 30_000)).toBe(false);
});
```

另测非 owner 不能 release，过期 owner 不能提交 lease-guarded write。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteWriterLease.test.ts
```

Expected: FAIL，lease API 不存在。

- [ ] **Step 3：实现原子 lease API**

```ts
acquireWriterLease(ownerId: string, ttlMs: number): boolean;
renewWriterLease(ownerId: string, ttlMs: number): boolean;
releaseWriterLease(ownerId: string): void;
assertWriterLease(ownerId: string): void;
```

获取和续租使用事务及 owner/expiry 条件更新。所有 lease-guarded write 在同一 transaction 中调用 `assertWriterLease`，不能先检查后另开事务写入。

- [ ] **Step 4：运行并确认 GREEN**

```powershell
npm test -- test/intelligence/sqliteWriterLease.test.ts test/intelligence/sqliteIndexJobs.test.ts
npm run typecheck
```

Expected: 全部通过，fake clock 不使用真实 sleep。

- [ ] **Step 5：提交**

```powershell
git add src/extension/intelligence/storage/sqliteIndexStore.ts test/intelligence/sqliteWriterLease.test.ts
git diff --cached --check
git commit -m "feat(intelligence): enforce sqlite writer lease"
```

## Task 7：接入 Lease 续租、只读降级和恢复

**Files:**

- Create: `test/intelligence/sqliteIndexWorkerLease.test.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- Modify: `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- Modify: `src/extension/intelligence/storage/indexDatabase.ts`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-storage-worker-design.md`

- [ ] **Step 1：写 fake-timer 状态机失败测试**

```ts
it("falls back to read_only after renewal failure and later recovers", async () => {
  const fixture = createLeaseWorkerFixture({ ttlMs: 30_000 });
  await fixture.worker.initialize();
  expect(fixture.worker.status().role).toBe("writer");
  fixture.store.failNextRenewal();
  await fixture.clock.advanceAsync(10_000);
  expect(fixture.worker.status().role).toBe("read_only");
  expect(fixture.worker.claimNextJob()).rejects.toThrow(/read.only/i);
  fixture.store.allowAcquire();
  await fixture.clock.advanceAsync(10_000);
  expect(fixture.worker.status().role).toBe("writer");
  expect(fixture.store.recoverInterruptedJobs).toHaveBeenCalled();
});
```

另测 dispose 取消 renewal/retry timer，仅 owner 释放 lease，并 checkpoint WAL。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/intelligence/sqliteIndexWorkerLease.test.ts
```

Expected: FAIL，worker 尚无 lease 状态机。

- [ ] **Step 3：实现 worker lease 生命周期**

status DTO 定义为：

```ts
type IndexWorkerStatus = {
  state: "initializing" | "ready" | "failed" | "closed";
  role: "writer" | "read_only";
  schemaVersion: number;
  capabilities: SqliteCapabilities;
};
```

writer 以 TTL/3 续租；失败立即转 read_only 并停止写 RPC。read_only 有界重试；成功后 recover stale jobs，再报告 writer。dispose 顺序为取消 timer、完成/回滚当前请求、owner-match release、WAL checkpoint、close、退出。

client 增加 `onDidChangeStatus(listener)`，只传递 `IndexWorkerStatus` DTO。后续 workspace adapter 用它在 writer/read_only 转换时启动或停止 watcher；listener disposal 不终止 worker。

- [ ] **Step 4：运行本阶段全量验证**

```powershell
npm test -- test/intelligence/sqliteCapabilities.test.ts test/intelligence/indexMigrations.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts test/intelligence/sqliteIndexJobs.test.ts test/intelligence/sqliteWriterLease.test.ts test/intelligence/sqliteIndexWorkerLease.test.ts test/sqliteWorkerBundle.test.ts
npm run typecheck
npm run compile
npm run test:vscode:sqlite-probe
git diff --check
```

Expected: 全部 exit code 0；最低宿主 probe 仍通过；两个实例测试证明任一时刻最多一个 writer。

- [ ] **Step 5：更新规格状态并提交阶段门禁**

把存储规格状态改为“已实现并通过最低宿主探针，等待总体验证”，记录实际命令和偏差。提交：

```powershell
git add src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts src/extension/intelligence/storage/sqliteIndexWorker.ts src/extension/intelligence/storage/sqliteIndexWorkerClient.ts src/extension/intelligence/storage/indexDatabase.ts test/intelligence/sqliteIndexWorkerLease.test.ts docs/superpowers/specs/2026-07-11-sqlite-index-storage-worker-design.md
git diff --cached --check
git commit -m "feat(intelligence): manage sqlite writer lifecycle"
```

## 计划完成记录

执行完成后记录：实际提交 hash、最低 VS Code/Electron/Node 版本、capability DTO、测试命令结果、与规格的偏差和技术债。只有 Task 1-7 全部完成后才能进入 chunk/snapshot 计划。
