# 动态工作流 P0 修复记录

## 范围

修复节点失败后仍被父代理当作成功并输出总结的问题，同时保留失败节点的错误结果，供后续恢复或重规划使用。

## 已完成

> 2026-07-31 复核修正：本节原先记录的 5 条中有 4 条在代码中并不存在（`workflowStatus`、
> `failedNodes`、`unreachedNodes`、`succeeded` 四个标识符全仓检索为零命中）。已按实际代码状态
> 重写。真正落地的部分见下，缺口由 `2026-07-31-expression-and-failure-visibility-fix.md` 补齐。

- ReAct 完成门禁不计入失败图；失败的 `runDynamicGraph` 必须由同名成功图覆盖，普通工具成功不能绕过门禁。
- `runDynamicGraph` 在零节点完成时抛错，避免模型凭空作答（仅覆盖全败场景，部分失败仍会返回成功）。

## 当时未落地（已由后续切片修复）

- `runDynamicGraph` 未返回 `workflowStatus`、`failedNodes`、`unreachedNodes`。
- 状态驱动路径 `executeCompiledGraph` 只把 `completed` 结果写入 `results`，失败结果被丢弃。
- 该路径的 `GraphCompleted` 硬编码 `failedNodes: []`、`unreachedNodes: []`。
- 无 `succeeded` 字段；部分成功部分失败的图仍作为成功返回。

## 验证

- `npm.cmd run compile`：通过。
- 工作流相关 5 个测试文件：71 个用例通过。
- `npm.cmd run typecheck`：被仓库已有 Java 适配器、`codeReviewTool` 和 Webview 类型错误阻断。
- 全量单测：包含已有失败并在 120 秒超时，未作为本次修复通过依据。

## 后续

错误分类、RecoverySupervisor、checkpoint/resume、外部等待、计划粒度策略和 CDP 全流程验收仍按总计划实施。
