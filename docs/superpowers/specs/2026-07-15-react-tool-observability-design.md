# ReAct 工具调用可观测性设计

## 目标

让 LoopAgent 的 Process 面板逐轮显示 `exploreCode` 的查询词和返回字符数，以便区分“未命中代码”“重复查询”和“模型主动进行不同查询”。本次只增加可观测性，不改变模型决定是否调用工具、工具执行顺序或 `maxSteps` 行为。

## 根因证据

`reactAgentRunner` 当前对每次工具调用只发送固定文本 `Running tool exploreCode`。Webview 会去重相同 Process 文本，因此连续多轮调用在界面上只保留一条，无法判断每轮的查询和结果是否有效。

## 设计

`reactAgentRunner` 在执行 `exploreCode` 前后各发送一条带轮次的 `agentEvent`：

```text
Running tool exploreCode (step 1, call 1): reactAgentRunner maxSteps
Tool exploreCode returned (step 1, call 1): 4072 chars
```

- 仅改变 `exploreCode` 的事件；其他工具保持现有 `Running tool <name>` 文本。
- 查询词压缩连续空白并限制为 200 个 UTF-16 字符，避免 Process 被超长参数撑开。
- 查询包含 Windows 驱动器路径、UNC 路径、分隔符后的 POSIX 绝对路径，或显式 secret/token/API key/password/credential、Bearer 值、`sk-` 凭据时，整体替换为 `<sensitive query hidden>`。
- 工具结果只显示字符数，不显示源码内容、绝对路径、堆栈或密钥。
- 每条事件包含 step 和单步 call 序号，因此同一步的相同查询也不会被 Webview 去重。
- `exploreCode` 异常时保留现有 `runFailed` 行为，不伪造成功结果事件。

## 修改范围

- `src/extension/agent/reactAgentRunner.ts`：生成请求与完成事件。
- `test/reactAgentRunner.test.ts`：验证查询摘要、结果字符数、同一步事件唯一性和敏感查询隐藏。
- `test/providerRegistryCodeContext.test.ts`：验证生产 provider 链路的新事件格式。
- 不修改消息协议、Webview 状态结构、模型请求或本地搜索实现。

## 验证

1. 先运行 `npm test -- test/reactAgentRunner.test.ts`，确认新增期望在实现前失败。
2. 实现后运行受影响测试、类型检查、全量测试、构建和 `git diff --check`。
3. 重新打包并覆盖安装 VSIX。
4. 在同一个 VS Code 窗口提问“当前react的实现”，记录每轮 query、返回字符数和最终状态。
