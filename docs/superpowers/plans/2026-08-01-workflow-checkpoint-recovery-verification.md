# 动态工作流检查点与可恢复执行验证记录

## 验证范围

验证对象是 `runDynamicGraph` 的 legacy/compiled 两条入口，覆盖检查点持久化、失败恢复、重启可用的会话身份传递、失败分类、执行效率和边界拒绝。真实宿主只使用一个固定 CDP 9333 的 Extension Development Host，未输出任何模型密钥。

## 自动化结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm test -- --run test/extension/conversation/workflowCheckpoint.test.ts test/extension/conversation/persistentConversationStore.test.ts` | 通过 | 20 个对话存储/检查点测试 |
| `npm test -- --run test/dynamicWorkflowTools.test.ts test/dynamicGraphWorkflow.test.ts test/workflow/toolFailureVisibility.test.ts` | 通过 | 48 个运行时测试 |
| `npm run compile` | 通过 | esbuild 生成扩展产物 |
| `git diff --check` | 通过 | 无空白错误 |
| `npm test` | 已知基线失败 | 92 个文件、854 通过、6 失败；失败集中在既有 `App` 编辑撤销、`codeReviewTool`、`exploreCodeSpool` 和 Windows `runCommand` 进程树清理，未触及本次检查点代码 |
| `npm run typecheck` | 已知基线失败 | 既有 `CodeReview*`、Java 解析器和 Webview 消息类型错误；本次修改文件没有新增类型错误 |

## 真实 CDP 结果

启动命令：

```powershell
npm run debug:vscode
```

固定条件：单一 Extension Development Host、`.local-vscode-user-data`、`.local-vscode-extensions`、CDP `127.0.0.1:9333`。

### 失败/重试

`scripts/test-workflow-recovery-cdp.mjs` 的 `timeout-retry` 场景真实调用了 `runDynamicGraph`，观察到 `timeoutMs: 1`、`retry.maxAttempts: 2`、`unresolvedFailures.code: "transient"` 和 `resumeToken`。当前工具返回体只暴露最终失败摘要，未暴露每次 attempt 的明细；运行时单元测试已确认同一节点最多执行两次。

### 边界

- `invalid-cycle-endpoint`：真实返回 `Cycle 'bad' to 'missing' is not an initial node`，未执行节点。
- `max-nodes-boundary`：真实返回 `Maximum nodes limit (1) exceeded`，两个节点均未执行。
- `test-simple-cycle-cdp.mjs`：真实触发 legacy cycle，`runDynamicGraph` 和 cycle 语义可见，工作流完成；Webview target 不允许 `Page.captureScreenshot`，截图失败不影响文本/状态验收。

### 执行效率

`run-latency-probe-e2e.mjs` 真实结果：

- 总耗时 `173482ms`
- 模型耗时 `53332ms`（约 30.7%）
- 工具耗时 `120150ms`（约 69.3%）
- `roundTrips: 7`
- 工具调用主要是重复的动态图规划，后续应优先减少父模型重复调用，而不是继续增加引擎抽象。

### 代码探索回归

`run-code-exploration-e2e.mjs` 真实触发 `runDynamicGraph`，两个节点同时进入运行状态；本次模型回合中一个只读子节点失败，脚本因此按“并发成功数不足 2”判为失败。这保留为模型/外部服务波动证据，不作为运行时恢复逻辑通过证据。

## 已知限制

1. CDP 脚本只能从 Webview 可见文本确认工具调用，不能直接读取 Extension Host 内部 SQLite；跨重启的 A/B 执行计数由 69 个运行时/存储测试覆盖，尚未用真实模型制造中途崩溃后重启。
2. `executor` 默认副作用为 `unknown`。失败后进入 `recovery_required`，不会自动重做编辑或命令；需要人工对账后再发起明确的新计划。
3. `npm test` 和 `npm run typecheck` 的既有失败仍需另开任务整改，本次不扩大范围修改无关模块。
