# SQLite 符号级增量代码索引总实施计划

> **Agent 执行要求：** 实施任何子计划前必须使用 `superpowers:using-git-worktrees` 创建独立 worktree，并选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。严格按子计划顺序执行 RED -> GREEN -> REFACTOR，不跨任务提前实现。

**目标：** 按六个可独立验收的阶段，把工作区代码索引迁移到 LoopAgent 自有 SQLite 数据库，并完成持久化检索、可选向量召回和真实宿主验证。

**架构：** 本文件只维护全局依赖、阶段门禁和最终验收。字段、行为和失败处理以六份子规格为准；具体源码、测试、命令和提交以六份子计划为准。

**技术栈：** TypeScript、VS Code Extension API、Node 22 `node:sqlite`、`worker_threads`、SQLite WAL/FTS5、web-tree-sitter、Vitest、esbuild、`@vscode/test-electron`。

---

## 文档矩阵

| 顺序 | 子系统 | 设计规格 | 实施计划 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 存储与 worker | [设计](../specs/2026-07-11-sqlite-index-storage-worker-design.md) | [计划](2026-07-11-sqlite-index-storage-worker-plan.md) | 待执行 |
| 2 | chunk 与 snapshot | [设计](../specs/2026-07-11-sqlite-index-chunk-snapshot-design.md) | [计划](2026-07-11-sqlite-index-chunk-snapshot-plan.md) | 阻塞于 1 |
| 3 | workspace 增量 | [设计](../specs/2026-07-11-sqlite-index-workspace-incremental-design.md) | [计划](2026-07-11-sqlite-index-workspace-incremental-plan.md) | 阻塞于 2 |
| 4 | 检索与上下文 | [设计](../specs/2026-07-11-sqlite-index-retrieval-context-design.md) | [计划](2026-07-11-sqlite-index-retrieval-context-plan.md) | 阻塞于 3 |
| 5 | embedding 与向量 | [设计](../specs/2026-07-11-sqlite-index-embedding-vector-design.md) | [计划](2026-07-11-sqlite-index-embedding-vector-plan.md) | 阻塞于 4 |
| 6 | 生命周期与验证 | [设计](../specs/2026-07-11-sqlite-index-lifecycle-validation-design.md) | [计划](2026-07-11-sqlite-index-lifecycle-validation-plan.md) | 阻塞于 5 |

总设计入口：[SQLite 持久化与向量代码索引总览](../specs/2026-07-10-sqlite-vector-code-index-design.md)。

## Worktree 基线

1. 从包含本总计划和六份子计划的最新 `main` 创建 feature worktree。
2. 不在当前主工作区直接实现。
3. worktree 创建后先运行：

```powershell
npm ci
npm test
npm run typecheck
npm run compile
git status --short
```

4. 基线失败时先记录现有失败，不把无关修复混入 SQLite 索引提交。
5. 整个项目复用同一个 feature worktree；子计划之间不重复创建 worktree。

## 全局执行约束

1. SQLite 是唯一持久化索引事实源，不并行维护完整内存 graph/search/source cache。
2. 变化文件仍完整 Tree-sitter 解析；只有 snapshot、FTS 和 embedding 使用 chunk 粒度更新。
3. 基础 exact/FTS/graph 检索必须在 embedding 未配置时完整可用。
4. 敏感路径在入队和读取前各检查一次，读取前检查是最终安全边界。
5. 所有生产查询都有明确 limit；不得增加完整图、全部 chunk 或全部 vector 读取接口。
6. 每个任务只提交其 `Files` 列表中的相关变更；提交前运行针对性测试和 `git diff --cached --check`。
7. 跨模块任务额外运行 `npm run typecheck`；构建或 bundle 任务额外运行 `npm run compile`。
8. 实现方向改变时，先更新对应中文规格和计划，再修改代码。

## 阶段门禁

每份子计划完成后必须同时满足：

- 子计划的全部任务和复选框已记录实际结果。
- 对应针对性测试、全量 typecheck 和 compile 通过。
- 对应设计规格状态更新为“已实现，等待总体验证”或“已实现并验证”。
- 没有临时脚本、调试日志、死文件或未登记技术债。
- 形成一个或多个小提交，且 `git diff --check` 通过。

后续计划不得通过 fake 或临时接口绕过前一阶段门禁。必要的测试 fixture 可以保留在测试目录，但不得进入生产路径。

## 最终验收

- [ ] 数据库只位于 `context.storageUri`，仓库中没有 SQLite、WAL 或 SHM。
- [ ] VS Code `1.101.0` 和当前版本均可加载 `node:sqlite`、FTS5、WAL 和 worker。
- [ ] 扩展重启后未变化文件不重新 parser/chunker。
- [ ] 单函数变化只更新对应 chunk、出边、FTS 和 embedding 状态。
- [ ] 纯行号移动只更新范围，不更新 FTS 或 embedding。
- [ ] 新增、删除、重命名后没有旧 chunk、孤立边或错误 FTS hit。
- [ ] 事务失败后查询读取完整旧版本，重启后 job 恢复。
- [ ] 未配置 embedding provider 时 exact、FTS 和 graph 独立可用。
- [ ] 两个实例共享数据库时任一时刻最多一个 writer。
- [ ] 敏感文件不会被读取或写入任一 SQLite 表。
- [ ] Extension Host 不保留完整仓库 source、extraction、graph 或 search Map。
- [ ] rebuild、clear、status 和 embedding key 命令通过自动化与真实宿主验证。
- [ ] 最低宿主、当前宿主、VSIX 和两个固定真实模型查询均有中文验证记录。
- [ ] `npm ci`、全量测试、typecheck、compile、宿主测试、VSIX 打包和 `git diff --check` 全部通过。

## 完成记录

执行时在文档矩阵中更新状态，并在每份子计划末尾记录实际提交、命令结果、偏差和技术债。不要在本总计划复制子计划的逐步实现内容。
