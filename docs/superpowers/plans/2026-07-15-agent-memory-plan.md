# 项目事实与任务经验记忆实施计划

> **For agentic workers / 面向智能体执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）
> 或 `superpowers:executing-plans` 按任务执行；用 `- [ ]` 更新步骤状态。执行时先通过
> `superpowers:using-git-worktrees` 创建隔离 worktree。

**目标：** 为同一 VS Code 工作区提供可持久化、可遗忘、带证据和新鲜度校验的项目事实与任务经验记忆。

**架构：** 使用 `node:sqlite` 建立独立 `memory.sqlite`，以 writer lease、generation CAS 和单事务维护
主表与 FTS5。先交付手动 Remember/View/Forget，再把有界记忆注入生产 ReAct，最后让代码搜索返回结构化
文件证据并由 runner outcome 自动沉淀任务经验；fake runner 和 Webview 协议保持不变。

**技术栈：** TypeScript、VS Code Extension API、Node.js `node:sqlite`/`node:crypto`、FTS5、Vitest。

---

## 文件边界

- 新建 `src/extension/memory/types.ts`：持久化 DTO、证据、outcome 与写入结果联合类型。
- 新建 `src/extension/memory/memoryStore.ts`：schema、WAL、lease、generation CAS、FTS、事务和保留策略。
- 新建 `src/extension/memory/projectMemory.ts`：脱敏、哈希校验、检索渲染、任务记录和生命周期。
- 新建 `test/memory/projectMemory.test.ts`：存储、并发、隐私、检索和遗忘的集中回归。
- 修改 `src/extension.ts`、`package.json`：工作区服务生命周期及 Remember/View/Forget 命令。
- 修改 `src/extension/model/providerRegistry.ts`：记忆 prompt 与 run generation 接线。
- 修改 `src/extension/agent/{reactTypes,toolRegistry,reactAgentRunner,exploreCodeTool}.ts`：结构化证据与终态回调。
- 修改 `src/extension/intelligence/workspaceIntelligence.ts`：在不破坏旧 prompt API 的前提下暴露结构化 snippet。
- 修改现有相关测试；最终新增 `docs/superpowers/plans/2026-07-15-agent-memory-verification.md`。

### Task 1：交付手动项目记忆闭环

**文件：**
- 新建：`src/extension/memory/types.ts`
- 新建：`src/extension/memory/memoryStore.ts`
- 新建：`src/extension/memory/projectMemory.ts`
- 新建：`test/memory/projectMemory.test.ts`
- 修改：`src/extension.ts:14`
- 修改：`package.json:9`

- [ ] **Step 1：先写 Remember -> 重启 -> View -> Forget 的失败测试**

```ts
it("persists a remembered fact and rejects a pre-forget generation", () => {
  const fixture = createMemoryFixture();
  const memory = openProjectMemory(fixture.databasePath, fixture.workspaceKey, fixture.readRange);
  const generation = memory.getGeneration();
  expect(memory.remember({ expectedGeneration: generation, kind: "fact", subject: "build", content: "Use npm run compile." })).toEqual({ ok: true });
  memory.dispose();

  const reopened = openProjectMemory(fixture.databasePath, fixture.workspaceKey, fixture.readRange);
  expect(reopened.list().map((item) => item.content)).toEqual(["Use npm run compile."]);
  expect(reopened.forget(reopened.getGeneration())).toEqual({ ok: true });
  expect(reopened.remember({ expectedGeneration: generation, kind: "fact", subject: "stale", content: "must fail" })).toEqual({ ok: false, reason: "generation_changed" });
});
```

`openProjectMemory(databasePath, workspaceKey, readRange)` 和 `createMemoryFixture()` 是本任务必须定义的
具体 API/测试 helper。同一文件补充：不同 workspace key 不串数据、两个数据库连接只有一个 lease owner、lease 到期可接管、敏感值返回
`{ ok: false, reason: "sensitive_content" }`、遗忘事务同步清空主表和 FTS。

- [ ] **Step 2：运行测试，确认因模块不存在而失败**

运行：`npm test -- test/memory/projectMemory.test.ts`

预期：FAIL，提示无法解析 `src/extension/memory/projectMemory`。

- [ ] **Step 3：实现最小 schema、lease、generation CAS 和同步 service**

`memoryStore.ts` 使用固定 V1 schema，不抽取通用 SQLite 层：

```sql
CREATE TABLE memory_meta(workspace_key TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, writer_owner TEXT, writer_expires_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE task_runs(id INTEGER PRIMARY KEY, workspace_key TEXT NOT NULL, task_summary TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL, verified INTEGER NOT NULL, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER NOT NULL);
CREATE TABLE memory_items(id INTEGER PRIMARY KEY, workspace_key TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, confidence TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, supersedes_id INTEGER);
CREATE VIRTUAL TABLE memory_fts USING fts5(subject, content, memory_item_id UNINDEXED);
```

打开数据库时设置 `journal_mode=WAL`、`foreign_keys=ON`、`synchronous=FULL`、`busy_timeout=5000`；所有
写方法在同一个 `BEGIN IMMEDIATE` 中依次验证 owner lease、`expectedGeneration`、主表变化和 FTS 变化。
缺失 meta 行以 generation `0` 原子创建；Forget 递增 generation 且保留 meta 行。同步数据库操作仅服务
最多 200 条 task run；`dispose()` 执行 WAL checkpoint 后关闭。`types.ts` 明确定义 `MemoryEvidence`、
`MemoryRunOutcome` 和写入结果联合类型。`openProjectMemory` 获取 30 秒 lease、每 10 秒续租或尝试接管，
`dispose()` 清理 timer 并释放 lease。在 `ProjectMemory` 中留下 `ponytail:` 注释，只有实测卡顿才迁 worker。

- [ ] **Step 4：注册三个原生命令并绑定服务生命周期**

在 `package.json` 增加 `loopagent.rememberProjectMemory`、`loopagent.showProjectMemory`、
`loopagent.forgetProjectMemory` 的 activation event 和 command title。`extension.ts` 在存在
`context.storageUri` 时创建 `memory.sqlite`；workspace key 是排序、规范化根路径的 SHA-256。打开失败降级为
无记忆模式；Remember 打开表单前捕获 generation，只允许 `fact|decision`；
View 使用 `showQuickPick`；Forget 使用 modal warning，失败时显示“未删除”。把 memory 的 `dispose()`
加入 `context.subscriptions`，无工作区时三个命令显示“当前没有可用工作区”。

- [ ] **Step 5：验证手动闭环与类型门禁**

依次单独运行：`npm test -- test/memory/projectMemory.test.ts`、`npm run typecheck`、`npm run compile`。

预期：测试 PASS，两个门禁 exit 0，manifest 中三个命令可打包。

- [ ] **Step 6：提交第一个纵向切片**

```powershell
git add package.json src/extension.ts src/extension/memory test/memory/projectMemory.test.ts
git commit -m "feat(memory): add project memory commands"
```

### Task 2：有界检索、源码失效与 prompt 注入

**文件：**
- 修改：`src/extension/memory/memoryStore.ts`
- 修改：`src/extension/memory/projectMemory.ts`
- 修改：`src/extension/model/providerRegistry.ts:27`
- 修改：`test/memory/projectMemory.test.ts`
- 修改：`test/providerRegistryCodeContext.test.ts`

- [ ] **Step 1：写检索与多文件失效的失败测试**

```ts
it("excludes an item when any required source range changes", async () => {
  const fixture = createMemoryFixture();
  fixture.writeActiveLesson({
    subject: "provider wiring",
    content: "Create the provider in providerRegistry.",
    evidence: [fixture.fileEvidence("src/a.ts", 1, 2), fixture.fileEvidence("src/b.ts", 3, 4)],
  });
  fixture.sources.set("src/b.ts:3:4", "changed");
  const context = await fixture.memory.loadContext("provider wiring");
  expect(context.prompt).not.toContain("Create the provider");
  expect(fixture.memory.list()[0]?.status).toBe("stale");
});
```

同一文件增加：FTS 输入只由转义 token 构造；最多 4 条 `fact|decision` 和 2 条 `lesson`、总计 2,400
字符；`</project-memory-data>` 只能出现在 JSON 字符串中；90/30/180 天和 200 条上限在写事务中清理。
`writeActiveLesson` 与 `fileEvidence` 是本测试文件内的 helper，分别调用 `MemoryStore.writeItem()` 和
SHA-256 生成受控 fixture，不向生产 API 增加测试后门。
在 `providerRegistryCodeContext.test.ts` 注入 fake `ProjectMemory`，断言记忆 prompt 与 runtime prompt 同时存在。

- [ ] **Step 2：运行聚焦测试，确认缺少 loadContext/接线而失败**

运行：`npm test -- test/memory/projectMemory.test.ts test/providerRegistryCodeContext.test.ts`

预期：FAIL，提示 `loadContext` 或 `projectMemory` dependency 尚不存在。

- [ ] **Step 3：实现检索、证据校验和固定数据块渲染**

`loadContext(task)` 返回 `{ generation, prompt, trace }`。Store 用参数化 `MATCH` 查询取得最多 12 个候选；
service 重新读取每个 required 文件范围并用 SHA-256 比较，任一失败立即排除。持有 lease 时把失配条目
事务性改为 `stale`；只读实例只排除。渲染采用固定 JSON 数据块：

```text
<project-memory-data trust="untrusted">
[{"kind":"fact","subject":"build","content":"Use npm run compile.","sources":["user_confirmation"]}]
</project-memory-data>
```

内容一律通过 `JSON.stringify`，不得拼接 role、工具定义或绝对路径。没有命中或任何异常时返回空 prompt。

- [ ] **Step 4：把记忆接入生产 systemPromptProvider**

给 `CreateConfiguredAgentRunnerDeps` 增加具体的 `projectMemory?: ProjectMemory`。在每次 request 中先调用
`loadContext(request.task)`，用 `Map<runId, generation>` 保存 generation，并按
`REACT_SYSTEM_PROMPT -> runtimePrompt -> memoryPrompt` 拼接。fake provider 分支保持原样；记忆失败不阻塞 run。

- [ ] **Step 5：验证项目事实跨 run 被注入且旧源码被排除**

运行：`npm test -- test/memory/projectMemory.test.ts test/providerRegistryCodeContext.test.ts`

预期：PASS，测试可观察到记忆 prompt、截断 trace 和 stale 排除。

- [ ] **Step 6：提交第二个纵向切片**

```powershell
git add src/extension/memory src/extension/model/providerRegistry.ts test/memory/projectMemory.test.ts test/providerRegistryCodeContext.test.ts
git commit -m "feat(memory): retrieve bounded project context"
```

### Task 3：结构化代码证据与自动任务经验

**文件：**
- 修改：`src/extension/intelligence/workspaceIntelligence.ts:37`
- 修改：`src/extension/agent/reactTypes.ts:20`
- 修改：`src/extension/agent/toolRegistry.ts:3`
- 修改：`src/extension/agent/exploreCodeTool.ts:8`
- 修改：`src/extension/agent/reactAgentRunner.ts:7`
- 修改：`src/extension/model/providerRegistry.ts:55`
- 修改：`src/extension/memory/projectMemory.ts`
- 修改：`test/exploreCodeTool.test.ts`
- 修改：`test/reactAgentRunner.test.ts`
- 修改：`test/providerRegistryCodeContext.test.ts`

- [ ] **Step 1：写工具证据和 completed/failed/cancelled outcome 的失败测试**

```ts
const recordOutcome = vi.fn();
const runner = createReactAgentRunner({
  recordMemoryRunOutcome: recordOutcome,
  modelTurn: async () => ({ kind: "final", content: "Used observation." }),
});
await collectRunnerMessages(runner);
expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
  runId: "run-1",
  status: "completed",
  finalContent: "Used observation.",
  evidence: [],
}));
```

在 `reactAgentRunner.test.ts` 分别验证 final、unknown tool、预先 abort 和执行中 abort 都只回调一次，并让现有
工具回合测试返回一条 file evidence 以验证累积；failed 和 cancelled 不提升。`exploreCodeTool.test.ts` 验证
snippet 路径、行范围和 SHA-256，不把源码正文写进证据。

- [ ] **Step 2：运行聚焦测试，确认结构化返回和 outcome 回调尚未实现**

运行：`npm test -- test/exploreCodeTool.test.ts test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts`

预期：FAIL，缺少 `evidence`、`recordMemoryRunOutcome` 或结构化 workspace result。

- [ ] **Step 3：暴露一次检索得到的 prompt 与 snippets**

在 `WorkspaceIntelligence` 增加兼容方法 `buildCodeIntelligenceResult?()`，返回
`{ prompt: string; snippets: CodeIntelligenceSnippet[] }`；现有 `buildCodeIntelligencePrompt()` 调用同一个内部
构建函数，避免重复索引。旧测试 mock 可继续只实现 prompt 方法，生产实现和新测试走结构化方法。

- [ ] **Step 4：让 ToolRegistry 规范化字符串和结构化工具结果**

定义 `ReactAgentToolResult = { content: string; evidence: MemoryEvidence[] }`；`invoke` 暂时接受旧字符串并在
registry 归一化为 `{ content, evidence: [] }`。`exploreCode` 对最多 4 个 snippet 计算 SHA-256，返回相对路径、
行范围、`required: true`；搜索失败返回无证据的原有受限 observation。

- [ ] **Step 5：在 runner finally 中只记录一次结构化 outcome**

新增可选 `recordMemoryRunOutcome` 回调。runner 累积本地 evidence 和最终文本；final 为 `completed`，受控
错误/步数上限为 `failed`，任何 AbortSignal 路径为 `cancelled`。finally 内捕获持久化错误，不改变现有
HostToWebviewMessage 序列。`providerRegistry` 用 Task 2 保存的 generation 调用
`projectMemory.recordOutcome(outcome, expectedGeneration)`，随后删除 Map 条目。

- [ ] **Step 6：自动沉淀一条有证据经验并验证完整集成**

`recordOutcome` 对 completed + file/verification evidence 写入一个 180 天有效的 active `lesson`；completed
无证据只写 candidate，failed/cancelled 只写 `task_runs`。补测 Forget 后旧 generation 的 in-flight outcome
不能重建 task run 或记忆项。摘要先脱敏并限制为 1,000 字符，不执行额外模型调用。

运行：`npm test -- test/exploreCodeTool.test.ts test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts test/memory/projectMemory.test.ts`

预期：PASS；随后分别运行 `npm run typecheck` 和 `npm run compile`，均应 exit 0。

- [ ] **Step 7：提交自动经验切片**

```powershell
git add src/extension/agent src/extension/intelligence/workspaceIntelligence.ts src/extension/model/providerRegistry.ts src/extension/memory test/exploreCodeTool.test.ts test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts test/memory/projectMemory.test.ts
git commit -m "feat(memory): record verified task experience"
```

### Task 4：集中门禁、真实用户路径与验证记录

**文件：**
- 修改：`docs/superpowers/specs/2026-07-15-agent-memory-design.md`
- 新建：`docs/superpowers/plans/2026-07-15-agent-memory-verification.md`

- [ ] **Step 1：执行清理检查和完整自动化门禁**

运行：`rg -n "TO[D]O|TB[D]|console\.log|debugger" src/extension/memory src/extension/agent src/extension/model/providerRegistry.ts`

预期：无临时调试代码；`rg` 无命中时 exit 1 可接受。

运行：`npm test`

预期：全部测试通过，0 failed。

运行：`npm run typecheck`

运行：`npm run compile`

预期：两条命令均 exit 0。

- [ ] **Step 2：在唯一调试窗口验证跨重启真实路径**

运行：`npm run debug:vscode`。在唯一 Extension Development Host 中执行：

1. `LoopAgent: Remember Project Memory` 保存 fact：subject=`memory verification phrase`，content=`cobalt-river-731`。
2. `LoopAgent: Show Project Memory` 确认条目可见。
3. 执行 `Developer: Reload Window`，重新打开 LoopAgent，在真实 DeepSeek 对话中询问该 phrase，确认回答命中。
4. 执行 `LoopAgent: Forget Project Memory`，再次 reload 后确认 View 为空且新任务不再获得该记忆。
5. 关闭该调试窗口，不启动第二个窗口。

- [ ] **Step 3：记录验证证据并同步规格状态**

验证文档用中文记录 commit、命令、测试统计、唯一调试窗口、Remember/View/Reload/Forget 的观察结果，
不记录完整模型回答、绝对数据库路径、源码 observation 或密钥。规格状态改为“实现完成并验证”仅在上述
全部门禁通过后进行；若真实 DeepSeek 环境不可用，保持“实现完成，真实路径待验证”并明确阻塞。

- [ ] **Step 4：提交验证记录和规格状态**

```powershell
git add docs/superpowers/specs/2026-07-15-agent-memory-design.md docs/superpowers/plans/2026-07-15-agent-memory-verification.md
git commit -m "docs: verify project memory workflow"
```
