# 扩展生命周期与端到端验证实施计划

> **Agent 执行要求：** 在既有 SQLite feature worktree 中执行，选择 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。逐任务 RED -> GREEN -> REFACTOR。真实 VS Code 调试始终只使用 `npm run debug:vscode`，默认只保留一个 LoopAgent Extension Development Host。

**目标：** 将持久化索引接入扩展唯一生命周期，提供安全管理命令，删除旧生产内存索引，并完成最低宿主、当前宿主、VSIX 和真实模型验证。

**架构：** `activate` 创建一个共享 WorkspaceIntelligence；命令通过其管理 API 操作 worker/database。自动化集成测试先验证打包工作流，最后在唯一真实调试窗口记录跨阶段结果。

**技术栈：** VS Code Extension API、SecretStorage、`@vscode/test-electron`、`@vscode/vsce`、Vitest、esbuild、PowerShell。

**设计规格：** `docs/superpowers/specs/2026-07-11-sqlite-index-lifecycle-validation-design.md`

**前置门禁：** 前五份子计划全部完成；无 embedding 配置的基础检索与可选 vector 测试都通过。

---

## 文件职责

- `extension.ts`：唯一实例、命令注册和 subscription。
- `vscodeWorkspaceIntelligence.ts`：storageUri 派生、管理 API 和资源编排。
- `codeIndexCommands.test.ts`：命令契约和安全顺序。
- `run-sqlite-vscode-test.mjs`：固定最低宿主完整集成测试。
- `sqliteCodeIndexExtension.test.ts`：真实 Extension Host 工作区测试入口。
- `*-verification.md`：中文自动化、真实窗口和模型结果。

## Task 1：接入 StorageUri、单例和确定性 Dispose

**Files:**

- Modify: `src/extension.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`
- Modify: `test/mocks/vscode.ts`

- [ ] **Step 1：写 storageUri、单例、empty 和 dispose 顺序失败测试**

```ts
it("creates one workspace index under storageUri and disposes it once", async () => {
  const context = fakeExtensionContext({ storageUri: uri("E:/storage/workspace") });
  activate(context);
  expect(createVsCodeWorkspaceIntelligence).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ storageUri: context.storageUri }),
  );
  await disposeRegisteredSubscriptions(context);
  expect(workspaceIntelligence.dispose).toHaveBeenCalledOnce();
});

it("does not open a database without workspace storage", () => {
  activate(fakeExtensionContext({ storageUri: undefined }));
  expect(createSqliteIndexWorkerClient).not.toHaveBeenCalled();
});
```

另测两次模型请求复用同一个 intelligence/worker，以及 watcher -> coordinator -> indexer -> worker 的 dispose 顺序。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/extensionWorkspaceIntelligence.test.ts
```

Expected: FAIL，extension 尚未传 storageUri 或注册 async disposable。

- [ ] **Step 3：实现单例创建和路径边界**

数据库固定为 `Uri.joinPath(context.storageUri, "loopagent-code-index.sqlite")`。无 storageUri/workspace 时创建 empty intelligence。所有 disposable 注册 `context.subscriptions`；包装 async dispose，确保多次调用只执行一次。

本任务同时把 `context.secrets` 和 workspace embedding config 注入前一计划定义的 optional embedding runtime factory；disabled 或配置不完整时仍传 `undefined`，不得复用聊天模型 key。

启动按 capability -> migration -> lease -> recover/scan -> watcher/coordinator；失败返回结构化 failed 状态，不创建完整内存 fallback。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/extensionWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
npm run typecheck
npm run compile
```

Expected: 全部通过，worker 创建一次、dispose 一次。

- [ ] **Step 5：提交**

```powershell
git add src/extension.ts src/extension/intelligence/workspaceIntelligence.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/extensionWorkspaceIntelligence.test.ts test/mocks/vscode.ts
git diff --cached --check
git commit -m "feat(intelligence): attach persistent index lifecycle"
```

## Task 2：注册 Status 和 Embedding Key 命令

**Files:**

- Create: `test/codeIndexCommands.test.ts`
- Modify: `package.json`
- Modify: `src/extension.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/packageManifest.test.ts`
- Modify: `test/mocks/vscode.ts`

- [ ] **Step 1：写 manifest、status DTO 和 secret 命令失败测试**

```ts
it("reports a serializable status without paths or source", async () => {
  const fixture = activateCommandFixture();
  const status = await fixture.execute("loopagent.showCodeIndexStatus");
  expect(status).toEqual(expect.objectContaining({
    state: "ready",
    role: "writer",
    capabilities: expect.objectContaining({ sqlite: true, fts5: true }),
  }));
  expect(JSON.stringify(status)).not.toContain("E:\\");
});

it("stores and clears only the embedding secret", async () => {
  const fixture = activateCommandFixture();
  await fixture.execute("loopagent.setEmbeddingApiKey");
  expect(fixture.secrets.store).toHaveBeenCalledWith(
    "loopagent.codeIndex.embedding.apiKey",
    "entered-key",
  );
  await fixture.execute("loopagent.clearEmbeddingApiKey");
  expect(fixture.secrets.delete).toHaveBeenCalledWith("loopagent.codeIndex.embedding.apiKey");
});
```

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/codeIndexCommands.test.ts test/packageManifest.test.ts
```

Expected: FAIL，命令尚未贡献和注册。

- [ ] **Step 3：贡献并注册三个命令**

```text
loopagent.showCodeIndexStatus
loopagent.setEmbeddingApiKey
loopagent.clearEmbeddingApiKey
```

status 显示简洁信息并返回 DTO：state、role、capabilities、version、job/file/chunk/edge/embedding counts、last scan、bounded metrics。不得包含源码、vector、key 或绝对数据库路径。

本任务同时把 `WorkspaceIntelligence.getStatus` 明确定义为 `getStatus(): Promise<CodeIndexStatusDto>`；empty implementation 返回不打开数据库的 disabled DTO。

```ts
export type CodeIndexStatusDto = {
  state: "idle" | "indexing" | "ready" | "partial" | "failed" | "disabled";
  role: "writer" | "read_only" | "none";
  capabilities?: SqliteCapabilities;
  schemaVersion?: number;
  counts: { files: number; chunks: number; edges: number; pendingJobs: number; failedJobs: number };
  lastScanAt?: number;
};
```

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/codeIndexCommands.test.ts test/packageManifest.test.ts test/extensionWorkspaceIntelligence.test.ts
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add package.json src/extension.ts src/extension/intelligence/workspaceIntelligence.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/codeIndexCommands.test.ts test/packageManifest.test.ts test/mocks/vscode.ts
git diff --cached --check
git commit -m "feat(intelligence): expose code index status and secret commands"
```

## Task 3：实现安全 Clear 和保留旧库的 Rebuild

**Files:**

- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `test/codeIndexCommands.test.ts`
- Modify: `test/packageManifest.test.ts`

- [ ] **Step 1：写 clear 路径、rebuild 失败保留和顺序测试**

```ts
it("closes the worker before deleting the database set", async () => {
  const fixture = indexManagementFixture();
  await fixture.index.clear();
  expect(fixture.events).toEqual([
    "watcher:stop",
    "coordinator:stop",
    "indexer:stop",
    "worker:dispose",
    "database:delete-main-wal-shm",
    "worker:create",
    "scan:start",
  ]);
});

it("keeps the old database when temporary rebuild initialization fails", async () => {
  const fixture = indexManagementFixture({ failTemporaryInitialize: true });
  await expect(fixture.index.rebuild()).rejects.toThrow(/temporary/i);
  expect(fixture.oldWorker.query).toHaveBeenCalled();
  expect(fixture.deleteOldDatabase).not.toHaveBeenCalled();
});
```

另测数据库目标不在 storageUri 内时拒绝删除；Windows 切换前关闭所有 handle。

- [ ] **Step 2：运行确认 RED**

```powershell
npm test -- test/codeIndexCommands.test.ts
```

Expected: FAIL，clear/rebuild API 不存在。

- [ ] **Step 3：实现管理 API 和命令**

`WorkspaceIntelligence` 增加：

```ts
clear(): Promise<void>;
rebuild(): Promise<void>;
```

贡献 `loopagent.clearCodeIndex` 和 `loopagent.rebuildCodeIndex`。clear 验证路径属于 storageUri 后删除 main/WAL/SHM。rebuild 在同目录临时库完成 capability/schema 验证后才停止旧 worker并切换；失败保留旧库。

- [ ] **Step 4：运行确认 GREEN**

```powershell
npm test -- test/codeIndexCommands.test.ts test/extensionWorkspaceIntelligence.test.ts test/packageManifest.test.ts
npm run typecheck
npm run compile
```

Expected: 全部通过。

- [ ] **Step 5：提交**

```powershell
git add package.json src/extension.ts src/extension/intelligence/workspaceIntelligence.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/codeIndexCommands.test.ts test/packageManifest.test.ts
git diff --cached --check
git commit -m "feat(intelligence): manage sqlite index rebuild and clear"
```

## Task 4：删除旧生产内存索引和过期测试

**Files:**

- Delete when consumer scan is empty: `src/extension/intelligence/graph/semanticGraph.ts`
- Delete when consumer scan is empty: `src/extension/intelligence/graph/graphTraverser.ts`
- Delete when consumer scan is empty: `src/extension/intelligence/graph/searchIndex.ts`
- Delete or reduce when consumer scan permits: `src/extension/intelligence/resolution/referenceResolver.ts`
- Delete when SQLite coverage is equivalent: `test/intelligence/semanticGraph.test.ts`
- Delete when SQLite coverage is equivalent: `test/intelligence/searchIndex.test.ts`
- Delete when SQLite coverage is equivalent: `test/intelligence/referenceResolver.test.ts`
- Modify: `src/extension/intelligence/workspaceIntelligence.ts`
- Modify: `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- Modify: `test/intelligence/workspaceIntelligence.test.ts`
- Modify: `docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md`
- Modify: `docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md`

- [ ] **Step 1：写生产边界失败测试**

```ts
it("does not retain repository-wide source extraction graph or token maps", () => {
  const source = readFileSync(resolve("src/extension/intelligence/workspaceIntelligence.ts"), "utf8");
  const vscodeSource = readFileSync(resolve("src/extension/intelligence/vscodeWorkspaceIntelligence.ts"), "utf8");
  expect(source).not.toMatch(/extractionCacheByFile|createSemanticGraph|createSearchIndex/);
  expect(vscodeSource).not.toMatch(/sourceCache|dirtyPaths|deletedPaths/);
});
```

- [ ] **Step 2：运行 consumer scan 和测试确认 RED**

```powershell
rg -n "semanticGraph|graphTraverser|searchIndex|referenceResolver|readSourceRangeFromText" src test
npm test -- test/intelligence/workspaceIntelligence.test.ts
```

Expected: scan 显示旧实现/测试消费者，架构测试 FAIL 或仍有待清理调用。

- [ ] **Step 3：逐个迁移 helper 并删除无消费者文件**

纯拆词 helper 移到 `chunking/searchText.ts`；仍使用的图类型保留在 `graphTypes.ts`。只有 SQLite 等价测试已覆盖且 `rg` 确认无生产消费者时删除实现和过期测试。同步两份旧设计文档，说明 SQLite 是最终状态。

- [ ] **Step 4：运行全量测试和无命中断言**

```powershell
npm test
npm run typecheck
npm run compile
$matches = rg -n "extractionCacheByFile|sourceCache|dirtyPaths|deletedPaths|createSemanticGraph|createSearchIndex" src/extension/intelligence
if ($LASTEXITCODE -eq 0) { throw $matches }
git diff --check
```

Expected: 测试/类型/构建通过，最后的生产路径 scan 无匹配。

- [ ] **Step 5：提交**

```powershell
git add -A src/extension/intelligence test/intelligence docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md
git diff --cached --check
git commit -m "refactor(intelligence): remove legacy in-memory index"
```

## Task 5：建立完整最低宿主和 VSIX 自动化验证

**Files:**

- Create: `scripts/run-sqlite-vscode-test.mjs`
- Create: `test/integration/sqliteCodeIndexExtension.test.ts`
- Create: `test/fixtures/sqlite-index-workspace/.gitkeep`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `esbuild.js`
- Modify: `scripts/run-sqlite-vscode-probe.mjs`

- [ ] **Step 1：写 full integration runner 和 package scripts**

固定开发依赖：

```powershell
npm install --save-dev @vscode/test-electron@3.0.0 @vscode/vsce@3.9.2
```

增加：

```json
"test:vscode:sqlite": "node scripts/run-sqlite-vscode-test.mjs",
"package:vscode": "vsce package --out dist/loopagent-vscode.vsix"
```

runner 使用 VS Code `1.101.0`、临时 user-data/extensions/workspace 目录和编译后的 integration entry；结束时清理临时目录。

- [ ] **Step 2：写真实 Extension Host 工作流断言**

`run()` 通过 VS Code API 和公开命令 DTO：

```ts
const status = await vscode.commands.executeCommand<CodeIndexStatusDto>(
  "loopagent.showCodeIndexStatus",
);
assert.equal(status?.capabilities.sqlite, true);
assert.equal(status?.capabilities.fts5, true);
assert.equal(status?.capabilities.wal, true);
assert.equal(status?.state, "ready");
```

随后创建两函数文件、等待 ready、warm restart、单函数修改、纯空行移动、新增/删除/重命名、敏感 watcher 文件、事务失败 hook、双实例 lease（可用独立 worker harness）、rebuild/clear、无 embedding query。所有等待使用有上限轮询，不固定长 sleep。

- [ ] **Step 3：运行确认 RED 并接入 bundle**

```powershell
npm run compile
npm run test:vscode:sqlite
```

Expected: 初次 FAIL，full integration bundle 或工作流尚未接入。随后在 `esbuild.js` 增加 test entry，并确保 production VSIX 排除 test bundle/fixtures。

- [ ] **Step 4：运行自动化和 VSIX 内容确认 GREEN**

```powershell
npm ci
npm test
npm run typecheck
npm run compile
npm run test:vscode:sqlite-probe
npm run test:vscode:sqlite
npm run package:vscode
Test-Path dist/loopagent-vscode.vsix
git diff --check
```

Expected: 全部 exit code 0，VSIX 存在，包内包含 extension、sqlite worker、Tree-sitter WASM，不含 test bundle、数据库或密钥。

- [ ] **Step 5：提交**

```powershell
git add package.json package-lock.json esbuild.js scripts/run-sqlite-vscode-probe.mjs scripts/run-sqlite-vscode-test.mjs test/integration/sqliteCodeIndexExtension.test.ts test/fixtures/sqlite-index-workspace/.gitkeep
git diff --cached --check
git commit -m "test(intelligence): verify packaged sqlite index workflow"
```

## Task 6：执行唯一真实窗口和固定模型验证

**Files:**

- Create: `docs/superpowers/plans/2026-07-11-sqlite-index-lifecycle-validation-verification.md`
- Modify: `docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-storage-worker-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-chunk-snapshot-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-workspace-incremental-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-retrieval-context-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-embedding-vector-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-sqlite-index-lifecycle-validation-design.md`
- Modify: `docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-plan.md`

- [ ] **Step 1：创建中文验证记录骨架**

报告章节固定为：环境、自动化命令、capabilities、cold/warm 指标、chunk 差异、敏感路径、lease、命令、VSIX 内容、固定查询 trace、回答结论、偏差、技术债。不得记录 API key、用户绝对路径或无关源码全文。

- [ ] **Step 2：启动并复用唯一调试窗口**

```powershell
npm run debug:vscode
```

只保留一个 LoopAgent Extension Development Host。执行 Open Panel、Show Status、连续查询、单函数修改、文件增删、rebuild、clear；需要加载新代码时刷新同一窗口，不重复启动。

- [ ] **Step 3：执行两个固定真实模型查询**

1. “模型集成是怎么实现的”：记录 exact/FTS/vector/graph trace，应命中 `providerRegistry.ts`、`modelRunner.ts`、`openAiCompatibleClient.ts`。
2. `assistantDelta`：记录 trace，确认 exact/FTS 强命中不被 vector 覆盖。

记录 `systemChars`、上下文文件、chunk kinds、截断、回答结论和持久化前后对比。原始 prompt 只保存在安全本地验证附件时，附件不得提交密钥或无关源码。

- [ ] **Step 4：执行最终命令并更新全部状态**

```powershell
npm ci
npm test
npm run typecheck
npm run compile
npm run test:vscode:sqlite-probe
npm run test:vscode:sqlite
npm run package:vscode
git diff --check
```

Expected: 全部 exit code 0。把六份规格改为“已实现并验证”，总计划矩阵六行改为“完成”，记录实际提交和偏差。

- [ ] **Step 5：提交验证与文档**

```powershell
git add docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md docs/superpowers/specs/2026-07-11-sqlite-index-*-design.md docs/superpowers/plans/2026-07-10-sqlite-vector-code-index-plan.md docs/superpowers/plans/2026-07-11-sqlite-index-lifecycle-validation-verification.md
git diff --cached --check
git commit -m "docs: record sqlite index verification"
```

## 计划完成记录

在验证报告中记录实际提交、所有命令 exit code、VS Code/Electron/Node 版本、唯一窗口证据、两个查询结果、清理结果、偏差和技术债。只有 Task 1-6 全部完成且总计划最终验收全勾选后，整个 SQLite 索引项目才完成。
