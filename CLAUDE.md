# LoopAgent VSCode Extension — Development Guidelines

## 代码搜索索引（`.loopagent/` 目录）

### 目录结构与内容

`.loopagent/` 是项目级的本地数据目录，**不提交到 git**。包含：

- `code-index.sqlite` — SQLite 数据库，存储 FTS5 全文搜索索引和代码元数据
- `daemon.pid` — 索引守护进程的进程号（内部使用）
- `daemon.log` — 索引构建日志
- `.gitignore` — 自动生成，忽略目录内所有文件（除了此 `.gitignore` 本身）

### 为何忽略 `.loopagent/`

1. **机器特有性**：SQLite 数据库是针对本机工作区的快照，多机共享会导致数据不一致
2. **大小**：大型工作区的索引数据库可达数百 MB，不适合版本控制
3. **实时性**：本地文件变化后 daemon 会自动增量更新索引，无需同步

### 索引重建

`.loopagent/` 目录损坏或过期时，直接删除：

```bash
rm -rf .loopagent/
```

扩展重启或下次 `buildCodeIntelligencePrompt` 调用时会自动重建。无需手动操作。

### 索引大小和性能

- **构建时间**：首次构建 ~100ms-21s，取决于工作区大小（500-10K 符号）
- **查询延迟**：<10ms（平均 ~7ms for 10K 符号）
- **磁盘占用**：约 10-50 MB（工作区大小的函数）

## 代码搜索架构

### 双路径查询设计

`buildCodeIntelligencePrompt(query)` 使用两层降级策略：

```
SQLite FTS (首选) → 快速、持久化
  ↓ [初始化失败、非 writer 角色、查询错误]
内存全量搜索 (降级) → 慢、兼容性好
```

#### 何时触发 SQLite 路径

- 工作区存在至少一个文件夹
- 本进程是持久化索引的 **writer** 角色（多窗口时仅一个窗口是 writer）
- SQLite 初始化成功

#### 何时触发内存降级

- 无工作区文件夹
- SQLite 初始化失败（权限、磁盘空间等）
- 本进程是持久化索引的 **reader** 角色（多窗口非 writer）
- SQLite 查询抛异常或返回空结果
- 工作区启动竞速条件（索引未就绪）

#### 状态和诊断

`getStatus()` 和 `getDiagnostics()` **始终**由内存路径提供，即使 SQLite 成功：

```ts
getStatus() → memoryIntelligence.getStatus()  // 内存索引状态
getDiagnostics() → memoryIntelligence.getDiagnostics() + persistentDiagnostic
```

这保证了即使 SQLite 不可用，用户仍能看到有效的诊断信息。

### 实现位置

| 组件 | 文件 | 职责 |
|------|------|------|
| SQLite 持久化索引 | `src/extension/intelligence/storage/sqliteIndexStore.ts` | FTS5 表管理、BM25 排序、持久化 |
| SQLite 查询层 | `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts` | 异步查询接口 |
| 内存降级 | `src/extension/intelligence/workspaceIntelligence.ts` | 全量重构、语义图、内存搜索 |
| 查询协调 | `src/extension/intelligence/vscodeWorkspaceIntelligence.ts` | 双路径路由、降级逻辑 |

## 性能基准

运行性能基准测试（见 [P4.1 性能基准](docs/superpowers/plans/2026-07-18-search-index-optimization-plan.md#p41-性能基准测试)）：

```bash
# 标准基准（推荐，500-10K 符号）
BENCH_SCALE=standard npm test -- benchmark-search-index

# 快速验证
BENCH_SCALE=quick npm test -- benchmark-search-index

# 完整测试（包括 50K 符号）
BENCH_SCALE=full npm test -- benchmark-search-index
```

预期结果：

| 工作区规模 | 平均查询延迟 | 通过条件 |
|---------|----------|--------|
| 500-1K 符号 | <5ms | ✓ |
| 5K 符号 | ~4-8ms | ✓ |
| 10K 符号 | ~7-10ms | ✓ |

详见 `docs/superpowers/plans/2026-07-18-search-index-optimization-plan.md` 的 P4.1 节。

## 开发注意事项

### 修改搜索实现

- **SQLite 侧**（`sqliteIndexStore.ts`, `sqliteIndexWorker*.ts`）— 不影响内存降级路径
- **内存侧**（`workspaceIntelligence.ts`, `graph/searchIndex.ts`）— 不涉及持久化
- 两层实现独立维护，避免交叉依赖

### 禁止操作

1. **不在 `workspaceIntelligence.ts` 中添加 SQLite 逻辑** — 保持纯内存隔离
2. **不删除内存降级路径** — 是 SQLite 不可用时的关键兜底
3. **不跳过降级到内存的情况** — 用户依赖这个兜底保证可用性

### 测试覆盖

- `test/intelligence/workspaceIntelligence.test.ts` — 内存路径单元测试
- `test/intelligence/benchmark-search-index.test.ts` — 性能基准
- `test/intelligence/sqliteSearchIntegration.test.ts` — 完整链路集成测试
- `test/intelligence/vscodeWorkspaceIntelligence.test.ts` — 双路径路由测试
