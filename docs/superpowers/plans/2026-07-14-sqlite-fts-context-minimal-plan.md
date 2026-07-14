# SQLite FTS 上下文最小实施计划

> **Agent 执行要求：** 在当前 checkout、当前分支使用测试先行逐项完成，步骤使用复选框跟踪。

**目标：** 将有界 SQLite FTS5 查询接入 VS Code 模型代码上下文，并在不可用时回退到既有内存索引。

**架构：** `SqliteIndexStore` 生成受控 FTS 查询，既有 worker/client 转发固定 chunk DTO；`createVsCodeWorkspaceIntelligence` 渲染命中结果，未命中或异常时调用原有 `WorkspaceIntelligence`。

**技术栈：** TypeScript、node:sqlite、SQLite FTS5、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-14-sqlite-fts-context-minimal-design.md`

## 全局约束

- 复用 `createSearchTokens` 和既有 SQLite worker，不新增依赖、配置、命令或 worker。
- FTS 查询和 `LIMIT` 使用绑定参数；空 token 不执行 `MATCH`；结果固定上限为 6。
- 不实现图扩展、RRF、embedding、索引任务等待或内存链路迁移。

## 任务 1：有界持久化 chunk 查询

**文件：**

- `src/extension/intelligence/storage/sqliteIndexStore.ts`
- `src/extension/intelligence/storage/sqliteIndexWorkerRuntime.ts`
- `src/extension/intelligence/storage/sqliteIndexWorkerProtocol.ts`
- `src/extension/intelligence/storage/sqliteIndexWorker.ts`
- `src/extension/intelligence/storage/sqliteIndexWorkerClient.ts`
- `test/intelligence/sqliteCodeSearch.test.ts`

- [x] 写失败测试：真实 SQLite snapshot 写入两个 chunk，断言标识符命中、特殊字符受限、空输入无命中。
- [x] 运行 `npm test -- test/intelligence/sqliteCodeSearch.test.ts --reporter=dot`，确认因 API 缺失而失败。
- [x] 增加固定 chunk DTO、store 查询和 worker RPC。
- [x] 运行 `npm test -- test/intelligence/sqliteCodeSearch.test.ts test/intelligence/sqliteIndexWorkerClient.test.ts --reporter=dot` 及 `npm run typecheck`。

## 任务 2：接入 VS Code prompt 并回退

**文件：**

- `src/extension/intelligence/context/codeIntelligencePrompt.ts`
- `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- `test/intelligence/vscodeWorkspaceIntelligence.test.ts`

- [x] 写失败测试：已就绪 fake client 返回持久化 chunk 时，prompt 使用该 chunk；空数组时仍返回内存 prompt。
- [x] 运行 `npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts --reporter=dot`，确认失败。
- [x] 持久化初始化后查询 6 个 chunk；命中时渲染安全 Markdown，未命中或异常时回退。
- [x] 集中运行受影响测试、全量测试、类型检查、编译和 `git diff --check`。

## 完成记录

2026-07-14：测试先行完成。首次 RED 分别验证 store/client API 缺失与 VS Code 未消费持久化 chunk；审查后新增并通过初始 drain 不阻塞、查询失败回退、6 条硬限制、敏感路径重过滤和 6,000 字符预算回归。最终 `npm test -- --reporter=dot` 为 50 个测试文件、263 个用例通过；类型检查、编译和 diff 检查通过。
