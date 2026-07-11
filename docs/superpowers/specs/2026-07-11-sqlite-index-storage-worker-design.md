# SQLite 存储与 Worker 设计

> 状态：实施中；运行时探针和 Worker RPC 已完成，最低宿主基线正在纠偏并复验。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-11-sqlite-index-storage-worker-plan.md`
>
> 本规格只负责运行时基线、SQLite schema、migration、worker RPC、持久化 job 和 writer lease。稳定 chunk 的生成与差异算法由后续规格定义。

## 目标

建立一个可迁移、可恢复、只由独立 worker 访问的 SQLite 存储层，为后续索引阶段提供稳定的数据契约和串行 RPC 边界。

## 范围

1. 提升 VS Code 和 Node 运行时基线并验证 `node:sqlite`、WAL、foreign key、FTS5。
2. 创建 version 1 schema、索引和显式 migration。
3. 构建独立 worker bundle、类型化 RPC client 和确定性关闭流程。
4. 持久化并恢复文件更新 job。
5. 实现完整 writer lease 状态机。

本规格不解析源码、不生成 chunk、不实现业务检索，也不接入 VS Code watcher。

## 运行时边界

- `package.json` 的 `engines.vscode` 提升到 `^1.103.0`。
- `esbuild.js` 的 extension 和 worker target 使用 `node22`。
- Extension Host 不直接调用 `DatabaseSync`；所有数据库操作在 `SqliteIndexWorker` 中完成。
- worker 使用独立 Node 22 CJS bundle `dist/sqliteIndexWorker.js`，并把 `vscode` 保持 external。
- 初始化必须在真实 Extension Host 和打包 VSIX 中再次验证，系统 Node 单元测试不能替代宿主验证。

最低版本必须固定为已经实际提供 FTS5 的宿主。VS Code `1.102.0`（Node `v22.15.1`、SQLite `3.49.1`）的 `PRAGMA compile_options` 不含 `ENABLE_FTS5`，实际返回 `no such module: fts5`；VS Code `1.103.0`（Node `v22.17.0`、SQLite `3.50.0`）的四项能力全部为 true。运行时、类型包和宿主测试统一使用 `1.103.0`，bundle target 仍为 `node22`。

worker 打开数据库后执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

初始化返回结构化 capability DTO。任何能力失败都使索引状态进入 `failed`，不得静默回退为完整内存索引。

## 持久化边界

必须持久化：文件元数据和 hash、节点、边、import binding、未解析引用、诊断、chunk、FTS、embedding、文件依赖、schema/index 版本和更新队列。

只能短期留在内存：parser/grammar、当前文件文本、临时 AST、一次 `ExtractionSnapshot`、worker 消息、当前查询候选、预算和最终 prompt。

## Version 1 Schema

### `files`

```text
id              text primary key
path            text not null
uri             text not null unique
language_id     text not null
content_hash    text not null
byte_length     integer not null
mtime           integer not null
index_state     text not null
extractor_ver   integer not null
chunker_ver     integer not null
indexed_at      integer not null
```

`id` 是规范化 workspace URI 的 SHA-256。`index_state` 只允许 `pending`、`indexing`、`ready`、`failed`、`deleted`。

### `nodes`

```text
id              text primary key
file_id         text not null
semantic_key    text not null
kind            text not null
name            text not null
qualified_name  text not null
start_line      integer not null
end_line        integer not null
start_column    integer
end_column      integer
signature       text
exported        integer not null default 0
content_hash    text not null
metadata_json   text
```

### `edges`

```text
id              text primary key
source_node_id  text not null
target_node_id  text not null
owner_chunk_id  text
kind            text not null
file_id         text
line            integer
confidence      text
metadata_json   text
```

### `chunks`

```text
id              text primary key
file_id         text not null
node_id         text
semantic_key    text not null
chunk_kind      text not null
source_text     text not null
search_text     text not null
embedding_text  text not null
source_hash     text not null
search_hash     text not null
embedding_hash  text not null
start_line      integer
end_line        integer
token_hint      integer
updated_at      integer not null
```

### `chunk_fts`

```sql
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  chunk_id UNINDEXED,
  search_text,
  tokenize = 'unicode61'
);
```

FTS 行由 snapshot 写事务显式维护，不使用隐式 content table trigger。

### Embedding 表

```text
embedding_cache
  provider        text not null
  model           text not null
  embedding_hash  text not null
  dim             integer not null
  vector_blob     blob not null
  created_at      integer not null
  primary key(provider, model, embedding_hash)

chunk_embeddings
  chunk_id        text not null
  provider        text not null
  model           text not null
  embedding_hash  text not null
  status          text not null
  attempts        integer not null default 0
  last_error      text
  updated_at      integer not null
  primary key(chunk_id, provider, model)
```

### 关系证据与诊断

```text
import_bindings(id, file_id, owner_chunk_id, imported_name, local_name, module_specifier, resolved_file_id)
unresolved_references(id, file_id, owner_chunk_id, reference_name, reference_kind, line, column, metadata_json)
file_dependencies(from_file_id, to_file_id, module_specifier, kind)

diagnostics
  id              text primary key
  file_id         text
  owner_chunk_id  text
  severity        text not null
  code            text
  message         text not null
  created_at      integer not null
```

### `index_jobs`

```text
id              integer primary key
file_uri        text not null unique
event_kind      text not null
status          text not null
attempts        integer not null
last_error      text
created_at      integer not null
updated_at      integer not null
```

`event_kind` 为 `create`、`change`、`delete`；`status` 为 `pending`、`running`、`failed`。同一 URI 的新事件通过 upsert 合并。

```ts
type IndexChange = { fileUri: string; eventKind: "create" | "change" | "delete" };

type ClaimedIndexJob = {
  id: number;
  fileUri: string;
  eventKind: "create" | "change" | "delete";
  claimedAt: number;
};
```

`claimedAt` 对应 claim 时写入的 `updated_at`，completion/failure 用 `(id, status, updated_at)` 条件更新，防止删除处理中到达的新事件。

### Migration 与 Meta

```text
schema_migrations
  version         integer primary key
  description     text not null
  applied_at      integer not null

index_meta
  key             text primary key
  value           text not null
```

`index_meta` 至少记录 workspace identity、schema version、extractor version、chunker version、embedding model、index format、writer owner、lease expiry、last successful scan 和 last rebuild time。

## 外键与索引

1. 文件所属表使用 `file_id -> files.id ON DELETE CASCADE`。
2. 可选节点引用使用 `ON DELETE SET NULL`；事实所属关系使用 `ON DELETE CASCADE`。
3. 为 `nodes(file_id)`、`nodes(name)`、`nodes(qualified_name)` 建立索引。
4. 为 `edges(source_node_id)`、`edges(target_node_id)`、`edges(owner_chunk_id)` 建立索引。
5. 为 `chunks(file_id)`、`chunks(node_id)`、`chunks(embedding_hash)` 建立索引。
6. 为 `file_dependencies(from_file_id)`、`file_dependencies(to_file_id)` 建立索引。
7. 为 `index_jobs(status, updated_at)`、`chunk_embeddings(status, updated_at)` 建立队列索引。

schema 测试必须通过 `PRAGMA table_info`、`foreign_key_list`、`index_list` 检查完整结构，不能只检查表名。

## Migration 与损坏恢复

`CURRENT_INDEX_SCHEMA_VERSION` 从 1 开始单调递增。每次 migration 在显式事务中执行，成功后同时写 `schema_migrations` 和 `PRAGMA user_version`。

遇到未知更高版本或明确不可迁移的 schema：

1. 关闭连接。
2. 将主库、WAL 和 SHM 移到同一个带时间戳的 backup 前缀。
3. 创建当前版本新库并安排全量重建。

普通权限、磁盘或路径 I/O 错误不得伪装为 schema 不兼容，也不得删除原库。

## Worker RPC

协议使用可辨识联合，每个请求包含递增 `id` 和固定 `kind`。基础协议至少包含：

```ts
type SqliteWorkerRequest =
  | { id: number; kind: "initialize"; databasePath: string; ownerId: string }
  | { id: number; kind: "getStatus" }
  | { id: number; kind: "enqueueChanges"; changes: readonly IndexChange[] }
  | { id: number; kind: "getPendingJobs" }
  | { id: number; kind: "dispose" };

type SqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
```

后续规格可以增加业务请求，但生产 client 不暴露任意 SQL。client 只用 `Map<number, PendingRequest>` 保存未完成 RPC；worker error、exit 或 dispose 必须拒绝所有 pending promise。

## 持久化 Job

连续事件按最终文件系统结果合并：

- create + change -> change
- 任意未处理事件 + delete -> delete
- delete 后路径重新出现 -> 处理前 stat 后转为 create

worker claim job 时原子地把 `pending` 改为 `running` 并增加 attempts。完成后删除 job；失败时保留该行并写入 `last_error`。启动和重新获得租约时，把超时 `running` 恢复为 `pending`。

完成 job 时只删除仍由本次 claim 持有且状态仍为 `running` 的行。若 watcher 在处理期间对同一 URI upsert 新事件，行会重新变为 `pending`，本次 completion 不得删除它；下一轮重新 stat 并处理最新文件系统结果。

## Writer Lease 状态机

`index_meta` 保存 owner 和绝对到期时间。获取和续租使用带 owner/expiry 条件的事务更新，不能覆盖其他实例的有效租约。

状态转换：

```text
initializing -> writer
             -> read_only
writer --renewal failure--> read_only
read_only --retry succeeds--> recovering -> writer
writer/read_only --dispose--> closed
```

规则：

1. writer 以不超过 TTL 三分之一的间隔续租。
2. claim job、snapshot、embedding 和 rebuild 等写事务在同一事务内验证 owner 与 expiry。
3. 续租或写前检查失败立即停止新写入，取消续租计时器并进入 `read_only`。
4. `read_only` 保持查询能力，以有界间隔重试获取租约，不忙循环。
5. 重新成为 writer 后先恢复 stale job，再运行工作区对账。
6. dispose 仅在 owner 匹配时释放租约，然后 checkpoint WAL 并关闭数据库。

## 失败与降级

- capability 失败：状态为 `failed`，返回可操作诊断。
- worker 崩溃：拒绝 RPC；下次初始化依赖 WAL 和 job 恢复。
- lease 丢失：状态为 `read_only`，查询继续，写入停止。
- migration 不兼容：备份并重建；I/O 错误原样上报。

任何失败都不得启用完整内存索引作为静默 fallback。

## 验证

1. 临时目录中验证完整 schema、外键动作、索引、FTS、WAL 和幂等 migration。
2. 验证未知新 schema 备份主库、WAL、SHM 后重建，普通 I/O 错误不重建。
3. fake worker 验证 RPC 配对、错误传播、exit 和 dispose。
4. fake clock + 两个数据库实例验证任一时刻最多一个 writer。
5. 验证续租失败转只读、只读查询、过期后接管和 stale job 恢复。
6. 编译后确认 `dist/sqliteIndexWorker.js` 存在，并在最低 VS Code `1.103.0` 中运行最小 capability probe；完整打包工作流复测归生命周期规格负责。

## 完成门禁

本规格完成后，后续规格可以依赖稳定 schema、类型化 RPC、可恢复 job 和 writer/read-only 状态，但不能假设源码抽取或检索已经存在。
