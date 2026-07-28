# 去掉默认 reviewer 子智能体实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 默认并行图只运行两个独立只读分析节点，由父智能体直接汇总结果，同时保留用户显式要求 reviewer 的能力。

**Architecture:** `runDynamicGraph` 继续负责单次建图和执行，不修改图引擎。生产提示词把默认聚合责任交给父智能体；E2E oracle 只接受恰好两个无依赖只读节点，并输出 `reviewerAbsent` 作为可观察证据。

**Tech Stack:** TypeScript、JavaScript、Vitest、VS Code Extension Host、DeepSeek OpenAI-compatible API。

## 全局约束

- 保留 `reviewer` 角色、`dependsOn`、`inputMapping` 和 resolver 能力。
- 仅当用户明确要求独立审查时允许创建 reviewer。
- 默认并行分析图恰好包含两个无依赖的 `explorer` 或 `planner` 节点。
- 父智能体必须报告失败节点，不创建补偿 reviewer。
- 不新增依赖，不修改 executor 权限和命令审批边界。

---

### Task 1: 把 E2E oracle 改成双节点并行、无 reviewer

**Files:**
- Modify: `test/codeExplorationE2e.test.ts`
- Modify: `scripts/codeExplorationE2e.js`
- Modify: `scripts/run-code-exploration-e2e.mjs`

**Interfaces:**
- Consumes: `evaluateCodeExploration({ process, answer, workflowEvents, graphNodes })`
- Produces: `{ passed, matchedAnchors, matchedPaths, missingStates, toolCalls, parallelReadOnlyNodes, reviewerAbsent }`

- [ ] **Step 1: 写失败测试**

把测试夹具改为两个并行完成的只读节点：

```typescript
const completeProcess = "runDynamicGraph\nDone";
const completedWorkflow: WorkflowEvent[] = [
  { agentId: "subagent-1", status: "running", at: 1 },
  { agentId: "subagent-2", status: "running", at: 2 },
  { agentId: "subagent-1", status: "completed", at: 5 },
  { agentId: "subagent-2", status: "completed", at: 6 },
];
const validGraphNodes: GraphNode[] = [
  { id: "webview", role: "explorer", dependsOn: [] },
  { id: "runtime", role: "planner", dependsOn: [] },
];
```

成功断言改为 `reviewerAbsent: true`，并新增一个用例：包含 reviewer、executor 或任意 `dependsOn` 的图必须 `passed === false`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd test -- --reporter=dot test/codeExplorationE2e.test.ts`

Expected: FAIL，现有 oracle 仍要求三个节点并返回 `reviewerCompleted`。

- [ ] **Step 3: 最小修改问题和 oracle**

`CODE_EXPLORATION_QUESTION` 明确要求第一张且唯一一张图恰好包含两个无依赖只读分析节点，并要求父智能体自行核对汇总。

```javascript
function hasRequiredGraphStructure(nodes) {
  return Array.isArray(nodes) &&
    nodes.length === 2 &&
    nodes.every(
      (node) =>
        ["explorer", "planner"].includes(node.role) &&
        (node.dependsOn ?? []).length === 0,
    );
}
```

`evaluateCodeExploration` 计算：

```javascript
const reviewerAbsent =
  Array.isArray(graphNodes) &&
  graphNodes.length > 0 &&
  graphNodes.every((node) => node.role !== "reviewer");
```

通过条件保留源码锚点、路径、`runDynamicGraph` 和 `parallelReadOnlyNodes >= 2`，删除 dependent reviewer 完成条件。`run-code-exploration-e2e.mjs` 的 JSON 输出把 `reviewerCompleted` 改为 `reviewerAbsent`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm.cmd test -- --reporter=dot test/codeExplorationE2e.test.ts`

Expected: 该文件全部 PASS。

- [ ] **Step 5: 提交 oracle 变更**

```powershell
git add scripts/codeExplorationE2e.js scripts/run-code-exploration-e2e.mjs test/codeExplorationE2e.test.ts
git commit -m "test: require reviewer-free parallel graph"
```

---

### Task 2: 让父智能体默认直接汇总图结果

**Files:**
- Modify: `test/providerRegistryCodeContext.test.ts`
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `docs/superpowers/guides/dynamic-graph-runtime.md`

**Interfaces:**
- Consumes: `GRAPH_TOOL_GUIDANCE`、`runDynamicGraph` 的结构化 `results`
- Produces: 父智能体默认双节点并行聚合规则；显式 reviewer 规则保持可用

- [ ] **Step 1: 写失败提示词测试**

在父 runner 系统提示测试中增加：

```typescript
expect(systemPrompt).toContain(
  "For parallel exploration, create only independent read-only nodes and aggregate their results yourself",
);
expect(systemPrompt).toContain(
  "Do not add a reviewer unless the user explicitly asks for an independent review",
);
```

保留 reviewer 使用 `inputMapping` 的现有断言，证明显式审查能力没有被删除。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd test -- --reporter=dot test/providerRegistryCodeContext.test.ts`

Expected: FAIL，系统提示尚未包含父智能体直接聚合约束。

- [ ] **Step 3: 最小修改生产提示词**

把 `GRAPH_TOOL_GUIDANCE` 的建图条件改为多路独立并行探索或单次工具预算不足；加入：

```typescript
"For parallel exploration, create only independent read-only nodes and aggregate their results yourself after runDynamicGraph returns.",
"Do not add a reviewer unless the user explicitly asks for an independent review.",
"When the user explicitly requests parallel analyses followed by independent review, make one reviewer depend on all analysis nodes and map every dependency's <node-id>.content through inputMapping.",
```

删除“默认需要 aggregating review”的表述，但不改角色、schema 或图执行代码。

- [ ] **Step 4: 更新运行指南**

在 `dynamic-graph-runtime.md` 中记录默认父聚合数据流、显式 reviewer 例外，以及 2026-07-28 双节点真实 E2E 验证目标；保留角色权限表。

- [ ] **Step 5: 运行受影响验证**

Run: `npm.cmd test -- --reporter=dot test/providerRegistryCodeContext.test.ts test/codeExplorationE2e.test.ts`

Expected: 两个测试文件全部 PASS。

Run: `npm.cmd run typecheck`

Expected: exit code 0。

Run: `npm.cmd run compile`

Expected: exit code 0。

- [ ] **Step 6: 提交运行时和文档**

```powershell
git add src/extension/model/providerRegistry.ts test/providerRegistryCodeContext.test.ts docs/superpowers/guides/dynamic-graph-runtime.md
git commit -m "feat: let parent aggregate parallel graph results"
```

---

### Task 3: 真实 DeepSeek 双子智能体验证

**Files:**
- Update: `docs/superpowers/plans/2026-07-28-remove-default-reviewer-plan.md`（勾选完成项并记录结果）
- Generated/ignored: `.artifacts/code-exploration-e2e.png`

**Interfaces:**
- Consumes: 固定端口 `9333`、固定目录 `.local-vscode-user-data` 和 `.local-vscode-extensions`
- Produces: 真实 `runDynamicGraph` 调用、两个并行只读节点、`reviewerAbsent: true`、完整父智能体答案

- [ ] **Step 1: 运行静态最终检查**

```powershell
npm.cmd test -- --reporter=dot test/providerRegistryCodeContext.test.ts test/codeExplorationE2e.test.ts
npm.cmd run typecheck
npm.cmd run compile
git diff --check
```

Expected: 所有命令 exit code 0。

- [ ] **Step 2: 刷新唯一调试窗口**

Run: `npm.cmd run debug:vscode`

Expected: 只存在一个 LoopAgent Extension Development Host，CDP 监听 `127.0.0.1:9333`。

- [ ] **Step 3: 运行真实 API E2E**

Run: `npm.cmd run test:e2e:code-exploration`

Expected JSON:

```json
{
  "passed": true,
  "toolCalls": ["runDynamicGraph"],
  "parallelReadOnlyNodes": 2,
  "reviewerAbsent": true
}
```

- [ ] **Step 4: 集中审查并提交完成记录**

确认 diff 不包含 `.codegraph`、密钥、临时日志或调试代码；在本计划中记录真实 E2E 耗时和结果。

```powershell
git add docs/superpowers/plans/2026-07-28-remove-default-reviewer-plan.md
git commit -m "docs: record reviewer-free graph verification"
```
