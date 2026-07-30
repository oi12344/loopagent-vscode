# Task 1 实施报告：固化新计划契约和迁移边界

## 实现内容

- 新增 `generatedWorkflowTypes.ts`，导出 `GeneratedWorkflowPlan`、`GeneratedWorkflowNode`、`CompiledWorkflowGraph`、`WorkflowCompileError` 和 `parseGeneratedWorkflowPlan`。
- 解析器仅做结构校验：要求非空 `nodes`、唯一且非空节点 ID、非空任务；关系字段支持字符串或字符串数组并归一化为数组。
- 严格拒绝未知字段、`cycles`、数组形式的 `initialState`、非正整数 `maxSteps` 和未知角色；错误包含字段路径及可用的节点 ID。
- 不检查 `after/contextFrom/reviews` 引用是否存在，留给后续编译器任务。
- 保留 `DynamicGraphDefinition` 的 `initialNodes`、`resolvers`、`cycles` 等旧字段，仅新增可选 `maxSteps`、`maxExecutions` 运行限制。

## TDD RED/GREEN

RED：

```powershell
npm.cmd test -- --reporter=dot test/workflow/generatedWorkflowTypes.test.ts
```

结果：因 `generatedWorkflowTypes.ts` 尚不存在而失败（模块找不到）。

GREEN：

```powershell
npm.cmd test -- --reporter=dot test/workflow/generatedWorkflowTypes.test.ts
```

结果：1 个测试文件、9 个测试全部通过。

## 文件清单

- `src/extension/agent/workflow/generatedWorkflowTypes.ts`
- `src/extension/agent/workflow/dynamicGraphTypes.ts`
- `test/workflow/generatedWorkflowTypes.test.ts`
- `.superpowers/sdd/task-1-report.md`

## 验证与自审

- `git diff --check`：通过。
- `npm.cmd test -- --reporter=dot test/workflow/generatedWorkflowTypes.test.ts`：通过，9/9。
- `npm.cmd run typecheck`：未通过，失败来自工作区已有的 `cycleManager.ts`、Java 语言适配器/AST 提取器及 `openAiCompatibleClient.ts` 类型错误；本任务新增文件未出现在错误列表中。
- 未修改运行时调度器、工具路由或 `CycleManager`。

## 疑虑

- 设计简报给出的 `reviews` 字段示例是 `string`，同时又要求关系字段统一归一化为数组；实现按归一化要求导出为 `string[]`。后续编译器应按数组消费。
