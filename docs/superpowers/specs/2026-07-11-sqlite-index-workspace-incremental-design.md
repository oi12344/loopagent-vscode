# 工作区增量索引设计

> 状态：等待书面规格评审。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 前置规格：SQLite 存储与 worker、稳定 chunk 与 snapshot 差异。

## 目标

把 VS Code 启动扫描和 watcher 事件统一写入持久化 job 队列，只读取并解析真正变化且允许索引的文件，并在导出变化后只重算受影响的跨文件关系。

## 范围

1. 工作区文件发现、元数据对账和重启复用。
2. 扫描、watcher 和 job 执行共享的敏感路径策略。
3. 持久化 create/change/delete 事件和串行 job 处理。
4. 文件删除、重命名、抽取失败和 shutdown 行为。
5. import binding、unresolved reference 和 file dependency 的增量重解析。

本规格不定义 SQLite schema、chunk 算法、召回排序或扩展命令。

## 模块边界

`vscodeWorkspaceIntelligence.ts` 只适配 VS Code API：列文件、stat、读文件、注册 watcher、规范化 workspace URI。它不保留仓库级源码缓存、dirty set 或 deleted set。

`workspaceIndexer.ts` 协调持久化 client、parser runtime、language adapter、snapshot builder 和路径策略：

```ts
type WorkspaceIndexerDeps = {
  listWorkspaceFiles(): Promise<WorkspaceFileRef[]>;
  statFile(file: WorkspaceFileRef): Promise<{ mtime: number; size: number }>;
  readFile(file: WorkspaceFileRef): Promise<string>;
  parserRuntime: ParserRuntime;
  getAdapter(languageId: string): LanguageAdapter | undefined;
  store: IndexStoreClient;
  isIndexableFile(file: WorkspaceFileRef): boolean;
};

type WorkspaceIndexer = {
  scanWorkspace(): Promise<void>;
  processNextJob(): Promise<boolean>;
  drain(options?: { timeoutMs?: number }): Promise<void>;
  dispose(): Promise<void>;
};
```

`SqliteIndexWorkerClient` 只交换 DTO，不接收 VS Code URI、Tree-sitter tree 或任意 SQL。

## 路径身份

文件 ID 基于规范化 workspace URI，而不是平台相关绝对路径。相对路径统一使用 `/` 分隔符并保留原始大小写用于展示；比较规则遵循 VS Code URI 语义。

多根工作区必须把 workspace folder identity 纳入 URI，避免两个 root 下同名相对路径冲突。

## 敏感路径双重门禁

扫描、watcher 和 job 执行共享一个纯函数策略，例如 `isIndexableWorkspacePath`。至少排除：

- `.git`、`node_modules`、`dist` 和其他构建输出。
- `.local-vscode-*` 本地调试目录。
- `.env`、`.env.*`。
- 文件名或路径段中明确表示 secret、token、API key 的文件。
- 当前项目已有的其他忽略规则。

门禁分两层：

1. 扫描或 watcher 入队前检查，排除路径不创建 `index_jobs`。
2. `processNextJob` 在 `stat`、`readFile` 和 parser 之前再次检查；这是最终安全边界。

若历史数据库已有现在被排除的路径，启动对账在不读取源码的前提下删除对应 file、chunk、关系和 job。路径策略变化不能留下旧敏感内容。

## 启动扫描

启动顺序：

1. 等待 storage worker 初始化和 writer lease 结果。
2. 只由 writer 恢复 stale `running` job。
3. 列出策略允许的 workspace 文件。
4. 比较 URI 集合，给新增和缺失文件入队 create/delete。
5. 对两边都存在的文件先比较 size、mtime、extractor version、chunker version。
6. 只有元数据或版本候选变化时才读取文件并计算 SHA-256 content hash。
7. content hash 不变时只更新文件元数据，不运行 parser/chunker。
8. content hash 或版本变化时入队 change。

扩展重启后，URI、size、mtime、content hash 和版本都未变化的文件不得调用 parser 或 chunker。

## Watcher 事件

worker 初始化完成后只注册一个 workspace watcher。handler 的职责：

1. 规范化 URI。
2. 执行第一层路径策略。
3. 写入一个 create/change/delete 事件。

handler 不读取文件、不计算 hash、不运行 parser，也不把事件保存在内存 Set。事件顺序不作为文件事实；job 执行前必须重新 stat 当前路径。

## Job 处理

writer 串行处理 job：

```text
claim job
  -> second policy gate
  -> stat current path
  -> missing: transactional remove
  -> exists: read latest bytes
       -> hash unchanged: metadata-only completion
       -> hash changed:
            parse -> extract -> build snapshot -> apply snapshot
            -> re-resolve impacted dependencies
  -> complete job
```

tree 在 `finally` 中释放一次。单文件抽取或 snapshot 失败时保留已提交旧索引，把 job 标记为 `failed` 并记录诊断；下一次文件变化或 rebuild 可以重试。

snapshot 应用成功但 job 完成前崩溃时，重启后的重复执行必须幂等。不得为了 job 原子性把 AST 解析放进数据库事务。

## 删除与重命名

删除在一个事务内：

1. 找出依赖当前文件的持久化证据。
2. 删除 file 行并通过外键清理所属事实、chunk、FTS 和 embedding 映射。
3. 删除或更新相关 dependency 行。
4. 重新解析受影响文件的持久化关系证据。

重命名按 delete + create 处理。稳定 embedding hash 仍可让新 chunk 复用内容寻址 cache，但文件和符号身份按新 URI 生成。

## 跨文件关系证据

持久化：

- `import_bindings`：imported name、local name、module specifier、resolved file。
- `unresolved_references`：引用名、kind、位置和 owner chunk。
- `file_dependencies`：from/to file、module specifier 和 dependency kind。

当文件导出集合变化时，根据 `file_dependencies.to_file_id` 找到直接依赖文件，只加载其持久化 binding/reference 和必要 node 候选，替换关系边与 unresolved row。不得重新读取或解析依赖文件源码。

依赖扩展必须有明确上限；循环依赖通过已访问 file ID 去重，不能递归加载整个仓库。

## 生命周期

- `read_only` 实例不扫描、不 claim job、不注册会产生写入的 watcher handler；它仍可查询最后提交索引。
- 实例重新获得 lease 后先恢复 job，再执行完整对账，最后开始正常 watcher/job 循环。
- dispose 顺序为停止 watcher、停止接收新 job、等待或取消当前 indexer 工作、释放 parser 临时对象、dispose worker client。
- shutdown timeout 必须可配置并记录诊断，不能无限等待。

## 失败与降级

- stat/read 竞争导致文件消失：按 delete 处理。
- 文件过大或语言不支持：记录有界诊断，不解析；若旧记录存在则按明确策略删除，不能继续提供过期内容。
- parser/adapter 失败：保留旧索引并标记 job failed。
- lease 丢失：停止处理队列并转只读。
- 路径策略拒绝：不读取文件，清理历史记录并完成 job。

## 验证

1. 冷启动索引后重启，未变化文件不调用 parser/chunker。
2. size/mtime 变化但 content hash 相同时只更新 metadata。
3. extractor/chunker version 变化时即使源码未变也重新生成 snapshot。
4. scan、watcher、已排队 job 三条路径都不能读取或持久化敏感文件。
5. create/change/delete 合并后按当前文件系统结果执行。
6. 新增、删除、重命名后 SQLite 不存在旧 chunk、FTS 或关系。
7. 导出变化只重算依赖文件关系，不调用依赖文件 parser。
8. parser 失败保留上一版索引，tree 恰好释放一次，job 可恢复。
9. read-only 实例不处理队列，接管 lease 后先对账再写入。

## 完成门禁

本规格完成后，SQLite 可以随工作区变化持续保持最新，并能在重启、删除、失败和多实例场景恢复；模型查询仍由后续检索规格接入。
