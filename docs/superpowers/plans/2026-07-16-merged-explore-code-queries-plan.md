# ReAct 同轮查询合并实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将同一模型步骤内多个 `exploreCode` 查询合并为一次真实检索，使 5 个同名搜索请求不再因原始请求数量超过上限而失败。

**架构：** 在 `createReactAgentRunner` 中预计算可安全合并的 `exploreCode` 查询，并以不同工具名称数量执行 `maxToolRequestsPerStep` 限制。首个 request ID 执行合并后的查询；其余 ID 保留合成 observation。查询长度超过现有上限时回退到原有首条执行行为。

**技术栈：** TypeScript、Vitest、现有 OpenAI-compatible ReAct runtime、VS Code VSIX E2E。

## 全局约束

- 仅合并同一步的 `exploreCode` 请求；其他工具的同名去重行为不变。
- 合并查询按首次出现顺序去重，以换行连接，最大长度复用 `exploreCode` 的 1000 字符上限。
- 首个 `exploreCode` request ID 获得真实合并 observation；每个其他 ID 获得明确的合成 observation。
- `maxToolRequestsPerStep = 3` 改为限制实际不同工具名称数量；4 个不同名称工具仍在执行前失败。
- 输入无效或合并后超过 1000 字符时，回退为现有首条执行、其余跳过行为。
- 保持 3 个可调用工具步骤加 1 个无工具最终回答步骤；不增加依赖、配置、Judge、planner 或通用调度层。
- 开发、测试和提交只在 `E:\zz\loopagent-vscode\.worktrees\limit-duplicate-tool-calls` 完成。

---

### Task 1：合并同轮 `exploreCode` 查询

**文件：**

- 修改：`src/extension/agent/exploreCodeTool.ts`
- 修改：`src/extension/agent/reactAgentRunner.ts`
- 修改：`test/reactAgentRunner.test.ts`
- 更新：`docs/superpowers/plans/2026-07-16-merged-explore-code-queries-plan.md`

**接口：**

- `exploreCodeTool.ts` 导出查询长度常量，供 Runner 复用。
- Runner 内部合并对象包含 `firstRequestId`、去重后的 `queries` 和 `query`；不改变 `ReactAgentTool`、`ReactModelTurn` 或模型协议类型。

- [ ] **步骤 1：写入失败的查询合并测试**

在 `test/reactAgentRunner.test.ts` 新增用例，模型第一步返回 5 个 `exploreCode` 请求，查询依次为 `alpha`、`beta`、`gamma`、`delta`、`epsilon`；下一步返回 final。断言：

```typescript
expect(invoke).toHaveBeenCalledTimes(1);
expect(invoke).toHaveBeenCalledWith(
  expect.objectContaining({
    input: { query: "alpha\\nbeta\\ngamma\\ndelta\\nepsilon" },
    request: expect.objectContaining({ id: "tool-1" }),
  }),
);
expect(followUpMessages.slice(-6)).toEqual([
  expect.objectContaining({ role: "assistant" }),
  expect.objectContaining({ role: "tool", requestId: "tool-1", content: expect.stringContaining("Combined 5 exploreCode queries") }),
  expect.objectContaining({ role: "tool", requestId: "tool-2", content: expect.stringContaining("combined into request tool-1") }),
  expect.objectContaining({ role: "tool", requestId: "tool-3", content: expect.stringContaining("combined into request tool-1") }),
  expect.objectContaining({ role: "tool", requestId: "tool-4", content: expect.stringContaining("combined into request tool-1") }),
  expect.objectContaining({ role: "tool", requestId: "tool-5", content: expect.stringContaining("combined into request tool-1") }),
]);
```

把现有“distinct tools once”用例的两个 `exploreCode` 查询期望改为合并后的 `"first\\nsecond"`，并断言第 2 个 request ID 的 observation 包含 `combined into request tool-1`。

新增“4 个不同名称工具”用例：默认上限下 4 个不同工具请求必须得到 `runFailed`，错误为 `Too many distinct tool requests in one step: 4`，且所有 `invoke` 均未调用。

- [ ] **步骤 2：运行定向测试并确认红灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts
```

预期：5 请求用例因现有原始请求上限报错而失败；两查询用例仍收到 `first` 而不是合并查询；4 个不同工具用例错误文案不匹配。不得出现类型、语法或环境错误。

- [ ] **步骤 3：实现最小合并和有效工具数限制**

在 `src/extension/agent/exploreCodeTool.ts` 导出：

```typescript
export const MAX_EXPLORE_CODE_QUERY_LENGTH = 1_000;
```

并用该常量替换本文件的私有长度常量。

在 `src/extension/agent/reactAgentRunner.ts`：

```typescript
const combinedExploreCode = combineExploreCodeRequests(result.requests);
if (new Set(result.requests.map((request) => request.name)).size > maxToolRequestsPerStep) {
  throw new Error(`Too many distinct tool requests in one step: ${new Set(result.requests.map((request) => request.name)).size}`);
}
```

`combineExploreCodeRequests` 只在至少两条 `exploreCode` 输入均为非空字符串、去重后的换行查询不超过 `MAX_EXPLORE_CODE_QUERY_LENGTH` 时返回合并对象。首条调用 `toolRegistry.invoke` 时传入合并后的 `input` 和 `rawArguments`；真实 observation 以 `Combined N exploreCode queries for this step.` 开头。后续同名请求使用：

```typescript
`Tool exploreCode query was combined into request ${firstRequestId} for this step. Review the combined observation before requesting it again in a later step.`
```

合并不可用时保留当前跳过文案和执行路径。

- [ ] **步骤 4：运行定向测试并确认绿灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts
```

预期：该文件全部通过；5 个同名请求只调用一次工具，4 个不同工具在执行前失败。

- [ ] **步骤 5：执行集中验证和真实 E2E**

独立运行：

```powershell
npm run typecheck
npm test
npm run compile
git diff --check
```

打包 worktree VSIX，在唯一 Extension Development Host 中运行：

```powershell
npm run test:e2e:code-exploration
```

记录实际 `Running tool exploreCode`、`Combined duplicate tool exploreCode`、步骤数量、答案锚点和路径；与当前“每轮跳过重复搜索”结果比较。

- [ ] **步骤 6：记录结果并提交**

在本文末尾追加中文实施结果，记录红灯、绿灯、全量验证、E2E 调用明细、合并是否发生和已知回退边界，然后提交：

```powershell
git add -- docs/superpowers/specs/2026-07-16-per-turn-tool-dedup-design.md docs/superpowers/plans/2026-07-16-merged-explore-code-queries-plan.md src/extension/agent/exploreCodeTool.ts src/extension/agent/reactAgentRunner.ts test/reactAgentRunner.test.ts
git commit -m "fix(agent): merge same-step code searches"
```
