# ReAct 单轮并发工具执行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 同一模型步骤内执行并完整回灌每个工具请求；连续只读请求并发、其他请求串行，单轮总量最多 10 个。

**架构：** `ReactAgentTool` 通过可选 `isConcurrencySafe(input)` 声明只读能力。Runner 依请求顺序分组，连续安全请求用 `Promise.all` 执行，完成后按原顺序写入工具结果。移除同名 `exploreCode` 查询合并、跳过 observation 及其专用长度依赖。

**技术栈：** TypeScript、Vitest、现有 OpenAI-compatible ReAct runtime、VS Code VSIX E2E。

## 全局约束

- 只在 `E:\zz\loopagent-vscode\.worktrees\limit-duplicate-tool-calls` 修改和提交。
- 每步最多 10 个原始工具请求；超过时零执行并返回 `runFailed`。
- 未声明 `isConcurrencySafe`、未知工具或判断异常均串行。
- 保持 3 个工具步骤与第 4 个无工具最终回答步骤。
- 不增加依赖、配置项、队列、Judge、planner 或工具注册表抽象。

---

### Task 1：替换同名合并为并发安全批次调度

**文件：**

- 修改：`src/extension/agent/reactTypes.ts`
- 修改：`src/extension/agent/exploreCodeTool.ts`
- 修改：`src/extension/agent/reactAgentRunner.ts`
- 修改：`src/extension/model/providerRegistry.ts`
- 修改：`test/reactAgentRunner.test.ts`
- 修改：`test/providerRegistryCodeContext.test.ts`
- 修改：`docs/superpowers/specs/2026-07-16-per-turn-tool-dedup-design.md`
- 修改：`docs/superpowers/plans/2026-07-16-merged-explore-code-queries-plan.md`
- 更新：`docs/superpowers/plans/2026-07-16-concurrent-tool-execution-plan.md`

**接口：**

```typescript
export type ReactAgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isConcurrencySafe?: (input: unknown) => boolean;
  invoke(invocation: ReactAgentToolInvocation): string | Promise<string>;
};
```

`exploreCode` 设置 `isConcurrencySafe: () => true`；其他未标记工具默认串行。

- [x] **步骤 1：写入失败的并发与配对测试**

替换 `test/reactAgentRunner.test.ts` 中两个查询合并用例：同一步返回 `tool-1`、`tool-2` 两个 `exploreCode` 请求时，两个 `invoke` 均收到各自原始 query，下一轮消息包含两条真实 observation，不包含 `Combined` 或 `combined into`。

新增并发用例，两个 `isConcurrencySafe: () => true` 的请求都先记录开始，再等待同一个 gate：

```typescript
const starts: string[] = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const invoke = vi.fn(async ({ request }) => {
  starts.push(request.id);
  await gate;
  return `${request.id} context`;
});

const run = collectRunnerMessages(runner);
await vi.waitFor(() => expect(starts).toEqual(["tool-1", "tool-2"]));
release();
await run;
```

新增串行用例：两个没有 `isConcurrencySafe` 的请求中，第一个等待 gate；断言第一个完成前第二个 `invoke` 未开始，释放后才开始。

把旧“4 个不同工具失败”改为 11 个请求，错误断言改为：

```typescript
message: "Too many tool requests in one step: 11"
```

并断言 11 个 `invoke` 均未调用。保留现有第 4 步禁止工具请求的测试。

在 `test/providerRegistryCodeContext.test.ts` 将旧的“每个工具每轮一次”断言替换为新的提示词契约：允许同轮独立只读搜索，但禁止精确重复搜索。

- [x] **步骤 2：运行定向测试并确认红灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts
```

预期：同名工具仍只执行一次、并发测试只能等到第一个请求、11 个请求未被旧的 3 条上限接受，且生产提示词仍包含旧限制；其他既有用例通过。

- [x] **步骤 3：实现最小并发批次调度**

在 `reactTypes.ts` 增加可选 `isConcurrencySafe` 类型；在 `exploreCodeTool.ts` 的工具对象中设置：

```typescript
isConcurrencySafe: () => true,
```

在 `reactAgentRunner.ts`：

```typescript
maxToolRequestsPerStep = 10,
```

并恢复对原始数量的检查：

```typescript
if (result.requests.length > maxToolRequestsPerStep) {
  throw new Error(`Too many tool requests in one step: ${result.requests.length}`);
}
```

删除 `MAX_EXPLORE_CODE_QUERY_LENGTH` 导入、`CombinedExploreCodeRequests`、`combineExploreCodeRequests`、`getExploreCodeQuery` 与 `getDuplicateToolObservation`。以私有批次 helper 取代它们：扫描原始请求，连续 `isConcurrencySafe(input) === true` 的请求形成并发批次；判断抛错时返回 `false`。每个批次先发出每条 `Running tool ...` 事件，再以 `Promise.all` 或单次 `await toolRegistry.invoke` 取回真实内容，按原始请求顺序发出 `Tool exploreCode returned ...` 事件并推入 `role: "tool"` 消息。

在 `providerRegistry.ts` 用下列两条替换旧的单次限制：

```typescript
"When separate read-only searches are needed, you may request them in one assistant turn.",
"Do not request an exact duplicate search or search again for facts already supported by source evidence.",
```

- [x] **步骤 4：运行定向测试并确认绿灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts
```

预期：并发安全同名请求均执行并按 request ID 回灌；未标记工具串行；11 条请求零执行失败；最终回答轮与现有取消/异常行为无回归。

- [x] **步骤 5：集中验证和真实 E2E**

独立执行：

```powershell
npm run typecheck
npm test
npm run compile
git diff --check
```

打包并在唯一 VSIX E2E 窗口运行：

```powershell
npm run package:vsix
npm run test:e2e:code-exploration
```

记录同轮多个 `exploreCode` 是否均显示 `Running tool exploreCode`、最终回答是否在第 4 步完成，以及答案锚点和源码路径。

- [x] **步骤 6：更新记录并提交**

在本文追加中文实施结果，记录 RED/GREEN、定向与全量验证、E2E 轨迹及未执行原因（如真实密钥或唯一窗口不可用）。在旧的同名去重设计和查询合并计划顶部追加一行中文注记，指向 `2026-07-16-concurrent-tool-execution-design.md`，说明其运行时策略已被并发执行替代。提交本任务涉及文件：

```powershell
git add -- src/extension/agent/reactTypes.ts src/extension/agent/exploreCodeTool.ts src/extension/agent/reactAgentRunner.ts src/extension/model/providerRegistry.ts test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts docs/superpowers/specs/2026-07-16-per-turn-tool-dedup-design.md docs/superpowers/plans/2026-07-16-merged-explore-code-queries-plan.md docs/superpowers/plans/2026-07-16-concurrent-tool-execution-plan.md
git commit -m "fix(agent): run safe tool requests concurrently"
```

## 实施结果

- 首轮 RED：`test/reactAgentRunner.test.ts` 和 `test/providerRegistryCodeContext.test.ts` 共 16 个用例，6 个按预期失败，分别覆盖同名执行、10 条上限、并发、串行和提示词契约；其余 10 个通过。
- 取消 RED：新增“首个进度事件后取消”回归时，Runner 仍会发出第 2 个安全工具事件；补回请求前与批次调用前的取消检查后通过。
- GREEN：两份定向测试共 17/17 通过。连续安全请求同时启动，未声明安全性的请求串行，所有工具结果按原 request ID 与原始顺序回灌。
- 集中验证：`npm run typecheck`、`npm test`（50 个测试文件、283 个用例）、`npm run compile` 和 `git diff --check` 均通过。
- VSIX：`npm run package:vsix` 成功，产物包含 25 个条目。
- 真实 E2E：唯一 VSIX E2E 窗口及 CDP 端口已启动，脚本到达插件模型调用后因固定用户数据和环境变量均无 DeepSeek API key 而报 `DeepSeek API key is not configured`。未读取密钥、未重试，故本次没有真实模型答案或同轮并发界面轨迹可记录。
