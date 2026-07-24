# Task 6 交付记录

## RED

- 先新增 `test/workflowTools.test.ts`，覆盖三个工具的成功路径与六类非法输入。
- 运行 `npm test -- test/workflowTools.test.ts`，因目标模块尚不存在而失败：`Cannot find module '../src/extension/agent/workflowTools'`。

## GREEN

- 新增 `src/extension/agent/workflowTools.ts`，仅校验输入、调用 `WorkflowOrchestrator` 和序列化 JSON 结果。
- 未增加 runner、权限或额外状态；三个工具均声明 `isConcurrencySafe: () => true`。
- 修正测试辅助函数，使同步校验异常作为 Promise 拒绝被断言。
- 运行 `npm test -- test/workflowTools.test.ts`：9/9 通过。

## 验证

- `npm run typecheck`：通过。
- `npm run compile`：通过。
- `git diff --check`：通过。
- `npm test` 首次运行时，既有 `test/runCommandTool.test.ts` 清理 Windows 临时目录出现 `EBUSY`；单独复跑 `npm test -- test/runCommandTool.test.ts`：5/5 通过。

## 改动与自审

- 新增三个主代理可见的工作流工具：创建、等待和取消子代理。
- 非对象输入、空白任务或 ID、非法数组成员和非正/非有限超时会在调用协调器前抛出明确错误；未知字段忽略。
- 等待结果由 `ReadonlyMap` 转为 JSON 可序列化的 `results` 记录。

## 提交

- `feat: add workflow agent tools`
