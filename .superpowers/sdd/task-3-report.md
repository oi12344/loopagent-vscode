# Task 3 工具路由报告

## 状态

已完成 `ToolRouter` 的最小实现。输入只使用现有 `ReactAgentTool[]`，输出始终是原数组中的子集并保持原始顺序。

## RED

先创建 `test/workflow/toolRouter.test.ts` 并运行：

```powershell
npm test -- test/workflow/toolRouter.test.ts
```

结果：失败，原因是 `src/extension/agent/workflow/toolRouter.ts` 尚不存在，测试无法导入 `selectTools`。这验证了测试先于实现。

## GREEN

新增 `selectTools(task, availableTools, toolHints?)`：

- 有有效 `toolHints` 时，只返回被显式提示的已有工具；返回顺序沿用 `availableTools`。
- 无提示时，按任务文本与工具名称/描述的关键词交集选择工具。
- `exploreCode` 不会由普通分析关键词自动选入，只有显式提示才会返回。
- 无匹配时优先返回 `readFile`，否则返回第一个工具；空数组返回空数组。

首次 GREEN 运行发现对 `Set` 使用 `.some()` 的实现错误，已改为迭代集合后复测通过。

## 改动文件

- `src/extension/agent/workflow/toolRouter.ts`
- `test/workflow/toolRouter.test.ts`
- `.superpowers/sdd/task-3-report.md`

未修改协调器、Provider 或工具权限。

## 测试与自审

```powershell
npm test -- test/workflow/toolRouter.test.ts
# 5 passed

npm test
# 68 files passed, 507 passed, 1 skipped

npm run typecheck
# passed

git diff --check
# passed
```

自审确认：显式提示、任务/描述匹配、高成本工具限制、`readFile` 兜底、首工具兜底、空数组和原顺序均有覆盖；实现未创建新工具或扩大工具权限。

## 提交

已以 `feat: route tools for workflow subagents` 提交。
