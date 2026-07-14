# 工作区持久化增量索引最小设计

> 状态：设计已确认，等待实施计划。
>
> 上位规格：`docs/superpowers/specs/2026-07-11-sqlite-index-workspace-incremental-design.md`
>
> 前置实现：SQLite storage worker、稳定 extraction snapshot 与最小 code card 已完成。

## 背景

当前生产链路在每次代码查询时重新枚举文件并构建内存图。SQLite 已能持久化单文件 snapshot、card 和 FTS，但启动扫描与 VS Code watcher 尚未接入，因此数据库不会随真实工作区持续更新。

完整增量规格还包含跨文件关系重算、writer lease 接管和后续检索迁移。本阶段只交付能独立运行的持久化写入闭环，避免在模型尚未消费 SQLite 前扩大实现范围。

## 目标

1. 扩展启动后扫描允许索引的工作区文件，并把新增、变化和删除写入持久化 job 队列。
2. 串行处理 job，把变化文件转换为稳定 snapshot 并事务写入 SQLite。
3. watcher 事件经过同一条队列更新数据库，不在 handler 中读取或解析源码。
4. 扩展重启后通过持久化元数据跳过未变化文件。
5. 解析失败时保留上一版可读 snapshot，并在关闭时确定释放 watcher、parser tree 和 worker。

## 非目标

- 不把模型查询切换到 SQLite 检索。
- 不实现跨文件依赖传播或关系增量重算。
- 不实现 embedding、向量召回或远程 provider。
- 不实现索引状态、清理、重建等用户命令。
- 不扩展复杂 card 类型或源码正文切分。
- 不执行完整 VSIX 或真实模型 E2E；这些留给后续生命周期验证阶段。

## 方案

新增独立 `WorkspaceIndexer`，复用现有 parser、language adapter、`buildExtractionSnapshot` 和 `SqliteIndexWorkerClient`。不把持久化副作用塞进查询时执行的 `createWorkspaceIntelligence`，也不建立通用 repository 或第二套 job 抽象。

```text
VS Code 启动扫描 / watcher
             |
             v
      WorkspaceIndexer
             |
             v
     SQLite 持久化 job
             |
             v
parse -> extract -> snapshot -> applyFileSnapshot
```

## 模块边界

### `workspaceFilePolicy.ts`

提供扫描、watcher 和 job 执行共享的纯函数：路径规范化、支持语言判断和敏感路径过滤。规则沿用现有 `vscodeWorkspaceIntelligence.ts`，不增加新的 ignore 配置系统。

### `workspaceIndexer.ts`

负责启动对账、job 串行处理、hash 判断和资源关闭。它只依赖文件系统适配接口、parser、adapter 和类型化 SQLite client，不直接导入 `vscode`。

最小公开行为：

```ts
type WorkspaceIndexer = {
  start(): Promise<void>;
  enqueue(change: IndexChange): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
};
```

`start` 完成初次对账并启动队列处理；同一实例只允许一个 drain 循环。`dispose` 后不接受新事件。

### `vscodeWorkspaceIntelligence.ts`

只适配 `findFiles`、`stat`、`readFile`、workspace URI 和一个 watcher。现有内存查询能力暂时保留，避免本阶段同时迁移读取链路。

### SQLite worker

在现有 RPC 上只补充三项必要能力：

1. 列出已索引文件的 `uri/mtime/byteLength/contentHash/version` 元数据。
2. 内容 hash 未变化时只更新文件元数据。
3. 按 URI 事务删除文件，并依靠外键清理所属 node、chunk、FTS 和关系。

不暴露任意 SQL，不增加 repository 层。

## 启动对账

1. 等待 worker 初始化；只有状态为 writer 时执行扫描和 job。
2. 枚举工作区文件并先执行路径策略，只对允许文件调用 `stat`。
3. 与 SQLite 文件元数据按规范化 URI 比较。
4. 数据库不存在的文件入队 `create`；文件系统不存在的记录入队 `delete`。
5. `mtime`、字节数、extractor version 和 chunker version 均未变化时直接跳过。
6. 候选变化文件入队 `change`，不在扫描阶段解析。
7. 对账完成后串行 drain；未变化重启不得调用 parser 或 chunker。

本阶段不实现 read-only 实例重新接管 lease。启动时不是 writer，则不扫描、不注册写入 watcher，并继续保留现有内存查询降级路径。

## Watcher 与 job

watcher handler 只规范化 URI、执行第一层路径策略并调用 `enqueueChanges`。同一路径的事件由现有 `index_jobs.file_uri UNIQUE` upsert 合并，job 执行时以当前文件系统状态为准。

job 流程：

```text
claim job
  -> 再次执行路径策略
  -> stat 当前文件
  -> 文件不存在：事务删除旧记录，完成 job
  -> 文件存在：读取最新内容并计算 SHA-256
       -> hash 未变化：只更新 mtime/size/version，完成 job
       -> hash 已变化：parse -> extract -> build snapshot
                       -> apply snapshot -> 完成 job
```

Tree-sitter tree 必须在 `finally` 中释放一次。解析和 snapshot 构建不放进 SQLite transaction；`applyFileSnapshot` 自身保持单文件原子性与幂等性。

## 失败与关闭

- 路径在入队后变为禁止：不得读取源码；若存在旧记录则删除并完成 job。
- `stat` 或读取期间文件消失：按删除处理。
- 文件过大或语言不支持：不解析，并删除可能存在的旧索引，避免继续返回过期内容。
- parser、adapter 或 snapshot 失败：不调用 `applyFileSnapshot`，保留旧 snapshot，并把 job 标记为 `failed`。
- 新 watcher 事件会使用现有 upsert 把同路径失败 job 重置为 `pending`。
- dispose 顺序为停止 watcher、拒绝新事件、最多等待当前 job 5 秒、释放临时 tree、dispose worker。超时只记录诊断并终止 worker；单文件事务仍保证不会提交半份 snapshot。

## 扩展接线

`LoopAgentChatViewProvider` 在拿到 `ExtensionContext` 后创建 workspace intelligence，使数据库固定写入 `context.storageUri/index/code-index.sqlite`。`storageUri` 不存在时不创建 worker；现有唯一 watcher 仍负责内存缓存失效，但不执行持久化入队。provider 的关闭路径负责调用新增的异步 `dispose`；`deactivate` 不再保留“无需清理”的假设。

本阶段不增加 package command、设置项或可见 UI。

## 验证

一个整体集成测试覆盖：

1. 模拟工作区启动，扫描文件并 drain，SQLite 中出现对应 file card 和 symbol card。
2. watcher 发出 change 后，只更新变化文件 snapshot。
3. watcher 发出 delete 后，file、chunk、FTS 和所属关系均消失。
4. 使用同一数据库重启，未变化文件不调用 parser。

必要回归覆盖：

- 扫描、watcher、job 三条路径均不会读取敏感文件。
- `mtime/size` 变化但 content hash 相同时只更新元数据。
- 解析失败保留旧 snapshot 且 job 为 failed。
- dispose 后不接收事件，并按顺序释放资源。

最终运行相关测试、`npm test`、`npm run typecheck`、`npm run compile` 和 `git diff --check`。

## 完成门禁

在真实扩展入口启动后，允许索引的工作区文件能自动写入 SQLite；新增、修改、删除会持续同步；重启不会重新解析未变化文件；失败不损坏旧 snapshot；关闭不遗留 watcher、tree 或 worker。达到这些条件后再进入 SQLite 检索接入，跨文件关系重算仍保留在完整增量规格中。
