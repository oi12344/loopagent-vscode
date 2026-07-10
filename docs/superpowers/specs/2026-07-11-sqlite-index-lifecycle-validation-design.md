# 扩展生命周期与端到端验证设计

> 状态：设计和实施计划已批准，等待执行。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-11-sqlite-index-lifecycle-validation-plan.md`
>
> 前置规格：其余五份 SQLite 索引子规格。

## 目标

把持久化索引接入 VS Code 扩展的唯一生命周期，提供安全的管理命令，删除已被替代的生产内存索引，并在最低宿主、当前宿主、打包 VSIX 和真实模型工作流中验证全部跨阶段承诺。

## 范围

1. `ExtensionContext.storageUri`、单例 workspace intelligence 和 dispose。
2. status、rebuild、clear 和 embedding key 命令。
3. capability 失败与无 workspace storage 的降级。
4. 旧生产实现、过期测试和不一致文档清理。
5. 最低 VS Code、当前 VS Code、VSIX、真实工作区和真实模型验证。

本规格不重新定义 schema、chunk、索引或排序算法，只验证并编排前置子系统。

## 扩展单例

`activate(context)` 最多创建一个 `WorkspaceIntelligence`，把 `context.storageUri` 和共享 parser runtime 注入，并把 disposable 注册到 `context.subscriptions`。

provider registry 和每次模型请求复用该实例，不新建 worker。没有 `storageUri` 或没有 workspace folder 时创建显式 empty intelligence，不打开数据库、不注册 watcher。

数据库路径只能由 `storageUri` 派生，status 和日志只显示路径类别或 workspace identity 摘要，不显示用户绝对路径。

## 启动顺序

```text
activate
  -> validate worker bundle and storage URI
  -> initialize worker and capabilities
  -> apply migration
  -> acquire writer lease or enter read_only
  -> writer recovers jobs and scans workspace
  -> register commands
  -> expose shared WorkspaceIntelligence
```

能力或初始化失败时状态为 `failed`，显示可操作诊断；只保留当前文件的既有轻量运行时上下文，不恢复完整内存索引。

## 关闭顺序

```text
stop accepting commands/watcher events
  -> dispose watcher
  -> stop indexer and embedding coordinator
  -> finish or rollback current transaction
  -> cancel lease timers
  -> release owned lease
  -> checkpoint WAL
  -> close worker connection
  -> terminate worker
```

正常 deactivation 不删除数据库。pending RPC 必须得到拒绝，dispose 可重复调用且只执行一次资源关闭。

## 管理命令

贡献并注册：

```text
loopagent.rebuildCodeIndex
loopagent.clearCodeIndex
loopagent.showCodeIndexStatus
loopagent.setEmbeddingApiKey
loopagent.clearEmbeddingApiKey
```

### Status

显示并返回可序列化 DTO，至少包含：state、read/write role、capabilities、schema/index version、pending/failed job、file/chunk/edge count、embedding 状态、最近扫描时间和有界写入指标。DTO 供集成测试调用，不包含源码、vector、key 或绝对数据库路径。

```ts
type CodeIndexStatusDto = {
  state: "idle" | "indexing" | "ready" | "partial" | "failed" | "disabled";
  role: "writer" | "read_only" | "none";
  capabilities?: SqliteCapabilities;
  schemaVersion?: number;
  counts: {
    files: number;
    chunks: number;
    edges: number;
    pendingJobs: number;
    failedJobs: number;
  };
  lastScanAt?: number;
};
```

### Clear

顺序固定为停止 watcher/coordinator/indexer、dispose worker、删除主库/WAL/SHM、创建新 worker、重新获取 lease、重新扫描。删除前验证目标路径确实位于 `storageUri` 内。

### Rebuild

在同一 storage 目录创建临时数据库，完整初始化并验证 schema/capability 后再停止旧 worker并切换。初始化失败时保留旧库和旧查询能力。Windows 上切换前关闭临时库和旧库，主库、WAL、SHM 作为一个集合处理。

### Embedding Key

set 命令写 SecretStorage；clear 命令删除 secret 并停止新 embedding 工作。命令不得显示现有 key，也不得把 key 写入 OutputChannel。

## 旧实现清理

只有 SQLite 生产入口和等价测试通过后才能删除：

- `semanticGraph.ts`、`graphTraverser.ts`、`searchIndex.ts` 的无消费者生产实现。
- 被 SQLite resolver 替代的 `referenceResolver.ts` 部分或全部实现。
- `sourceCache`、`dirtyPaths`、`deletedPaths`、`extractionCacheByFile`。
- 对应过期测试、临时脚本和废弃待办标记。

仍有真实消费者的纯类型或拆词函数移动到明确归属模块，不为保留 helper 而保留完整旧架构。同步更新旧 Tree-sitter/AST 设计文档，说明 SQLite 规格取代常驻内存状态。

## 构建与打包

构建产物至少包含：

- `dist/extension.js`
- `dist/sqliteIndexWorker.js`
- Tree-sitter runtime 和语言 WASM assets
- Extension Host integration test bundle（仅测试构建）

使用固定版本 `@vscode/test-electron` 运行最低 VS Code `1.101.0`，使用固定 `@vscode/vsce` 打包 `dist/loopagent-vscode.vsix`。VSIX 内容测试必须验证 worker 和 WASM 未被忽略。

## 自动化宿主验证

在临时 workspace 中通过命令 DTO 验证：

1. `node:sqlite`、FTS5、WAL、foreign key 和 worker ready。
2. 首次索引两个函数文件后 warm restart 不重新解析未变化文件。
3. 只修改一个函数时，其他 chunk 的 ID/hash/timestamp 不变。
4. 纯行号移动不产生 FTS 或 embedding 写入。
5. 新增、删除、重命名后计数和检索结果一致。
6. 敏感文件通过 scan 和 watcher 都不会被读取或持久化。
7. 注入事务失败后查询得到旧版本，重启后 job 恢复。
8. 两个实例共享数据库时最多一个 writer，另一个可查询并在 lease 过期后接管。
9. rebuild 失败保留旧库；clear 清理主库/WAL/SHM 后创建新库。
10. 未配置 embedding 时 exact/FTS/graph 仍可用。

## 当前 VS Code 真实窗口验证

严格复用一个 LoopAgent Extension Development Host，并只通过 `npm run debug:vscode` 启动：

1. 执行 `LoopAgent: Open Panel`。
2. 查看索引 status，确认 role、WAL、FTS5 和 worker。
3. 同一工作区连续提问两次，确认第二次不重解析未变化文件。
4. 保存单函数修改、新增文件、删除文件并检查指标与检索结果。
5. 执行 rebuild 和 clear，确认无第二个调试窗口和无遗留数据库句柄。

## 真实模型验证

固定查询：

1. 中文抽象问题：“模型集成是怎么实现的”。应命中 `providerRegistry.ts`、`modelRunner.ts`、`openAiCompatibleClient.ts` 等真实上下文。
2. 明确标识符：`assistantDelta`。应保持 exact/FTS 路径优先，不被 vector 噪音覆盖。

验证报告记录：

- VS Code、Electron 和 Node 版本。
- cold/warm parsed files 数量。
- SQLite row writes、FTS writes、embedding requests/invalidations。
- exact/FTS/vector/graph 各自命中的 chunk/node 和检索 trace。
- `systemChars`、上下文文件、预算、截断状态和回答结论。
- 持久化前后关键源码命中率和回答准确性对比。

允许记录发送给模型的 prompt 以供本地验证，但报告不得包含 API key、用户绝对路径或与验证无关的源码全文。

## 验证报告

创建中文验证记录 `docs/superpowers/plans/2026-07-11-sqlite-index-lifecycle-validation-verification.md`。实际实现偏差先回写对应子规格和子计划，再记录最终结果；不能只在报告中留下隐藏决策。

## 完成命令

```powershell
npm ci
npm test
npm run typecheck
npm run compile
npm run test:vscode:sqlite
npm run package:vscode
git diff --check
```

所有命令 exit code 为 0，VSIX 存在且包含 worker/WASM，自动化宿主与唯一真实调试窗口验证都有中文记录，才能声明整个项目完成。

## 最终清理门禁

1. 仓库中不存在 SQLite、WAL、SHM、临时 workspace 或调试凭据。
2. 没有无消费者旧索引文件、导出、过期测试、废弃待办标记或临时日志。
3. 六份子规格、六份子计划、总览和验证报告与最终实现一致。
4. 任何暂缓清理都在对应规格或计划登记为明确技术债。
