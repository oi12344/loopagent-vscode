# 动态工作流失败分析恢复切片

## 目标

失败节点先分析错误证据，再决定下一步动作；禁止对相同图参数进行盲目重试。

## 实现

- `runDynamicGraph` 失败后，ReAct 运行器将失败证据和恢复约束写入下一轮模型消息。
- 相同 `runDynamicGraph` 参数的失败调用被拦截，要求模型重建图或选择其他恢复动作。
- 动态图失败不再触发通用工具连续失败熔断；普通工具仍保留原有熔断保护。
- Webview 的 `runId` 使用时间和随机后缀，避免恢复会话后错误消息追加到旧助手卡片。

## 验证

- `npm.cmd run compile` 通过。
- `reactAgentRunner`、`App`、`dynamicWorkflowTools`、`superstepGraphEngine` 共 97 个测试通过。
- CDP 已验证失败节点显示失败、成功节点显示完成、父汇总不再伪成功；最新代码的 CDP 重启受本机 VS Code `state.vscdb` 只读环境阻断。

## 后续

将失败证据接入确定性的错误分类和 `RecoverySupervisor`，为重规划、替换节点、换工具、等待外部条件分别设置策略和上限。
