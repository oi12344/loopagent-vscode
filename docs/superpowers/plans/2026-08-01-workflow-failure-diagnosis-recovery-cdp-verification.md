# 失败诊断恢复 CDP 验收记录

## 入口与前置条件

- 在仓库根目录执行 `npm run compile`，确保 Extension Development Host 加载最新 `dist`。
- 使用固定的 CDP 端口 `9333`、`.local-vscode-user-data` 和 `.local-vscode-extensions`，测试期间只保留一个调试宿主。
- 执行 `node scripts/test-failure-diagnosis-recovery-cdp.mjs`。脚本通过 `scripts/cdpClient.mjs` 连接真实 Workbench 和 LoopAgent Webview。
- 本次机器上的 Electron renderer 需要 `--disable-gpu-sandbox --no-sandbox` 才能启动；这是调试宿主启动参数，不属于生产运行参数。代理和模型凭据只通过进程环境传入，未写入仓库、日志或验收产物。

## 场景

图包含 `prepare`、并行的 `analysis-a`/`analysis-b`、故意超时的 `flaky-check` 和依赖它的 `summary`。所有节点都声明严格 `exactText` 契约；`flaky-check` 声明 `timeoutMs: 1`、无副作用和单次初始尝试。失败后由诊断器读取失败证据，生成 `replace_node` 修复任务并把超时放宽到 `60000ms`；修复结果再次经过契约校验，只有通过后才调度 `summary`。

## 验收命令

```powershell
npm run compile
node --check scripts/test-failure-diagnosis-recovery-cdp.mjs
node scripts/test-failure-diagnosis-recovery-cdp.mjs --dry-run
node scripts/test-failure-diagnosis-recovery-cdp.mjs
```

脚本将摘要写入 `.artifacts/failure-diagnosis-recovery-cdp.json`。该目录是本地验收产物，不纳入提交。

## 最终真实结果

CDP 脚本退出码为 `0`，最终响应解析为：

```text
workflowStatus: completed
statusCounts: {"completed":5}
completedNodes: ["prepare","analysis-a","analysis-b","flaky-check","summary"]
failedNodes: []
unreachedNodes: []
executionOrder: ["prepare","analysis-b","analysis-a","flaky-check","summary"]
recoveryDiagnostics: [{"nodeId":"flaky-check","category":"transient","action":"replace_node","timeoutMs":60000}]
unresolvedFailures: []
```

结果证明：

- `flaky-check` 的超时失败原因、诊断分类和修复动作均可见；
- `flaky-check` 修复后精确返回 `FLAKY_CHECK_RECOVERED`，`summary` 精确返回 `SUMMARY_OK`；
- `prepare`、`analysis-a`、`analysis-b` 在执行顺序中各出现一次，没有回退重跑已完成上游；
- 没有遗留失败，也没有把失败节点的非法输出传给下游；
- 新 run 已接管并清除同一对话的旧 checkpoint payload，返回中没有 `checkpointError`；存储层保留终态 owner 栅栏，完成后的旧 run 迟到写入会被拒绝。

## 失败运行说明

曾在未刷新扩展宿主时运行到旧解析器，旧版本不接受 `exactText`；也曾暴露同一对话的新 run 被旧 checkpoint 拒绝的问题。两项都不是最终验收结果：前者通过固定调试环境刷新消除，后者已在存储所有权入口修复并增加回归测试。

本次最终验收前还捕获到诊断模型返回 `retry + task`：其意图是替换任务，但动作标签选成 `retry`，严格解析器拒绝后工作流安全停在 `recovery_required`，上游仍未重跑。工具层现仅对“`retry` 且 task 非空”归一化为 `replace_node`，再执行原有动作、目标、角色、副作用和预算校验；同一场景复测后 5 个节点全部完成。最终验收使用最新编译代码重新启动的唯一固定调试宿主。

## 后续限制

- `npm run typecheck` 仍会报告仓库既有的其他模块类型错误；本次受影响文件的编译和定向测试均通过，未扩大修复范围。
- CDP 场景覆盖单节点超时、诊断、替换修复、契约校验和下游放行；并发压力和外部副作用恢复属于后续专项测试范围。
