# 生产 ReAct 与代码搜索工具验证记录

> 日期：2026-07-13
>
> 分支：`codex/production-react-code-search`
>
> 结论：实现和自动化门禁通过；真实 DeepSeek 远端 `tool_calls` 因调试 profile 未配置 API key，尚未完成最终验收。

## 实现范围

- `src/extension/model/openAiCompatibleClient.ts` 支持 OpenAI-compatible `tools`、`tool_calls`、`tool_call_id` 和流式 finish reason。
- `src/extension/agent/openAiReactModelTurn.ts` 聚合工具调用分片，解析参数并生成完整 assistant/tool 历史。
- `src/extension/agent/exploreCodeTool.ts` 以只读工具包装 `WorkspaceIntelligence.buildCodeIntelligencePrompt(query)`。
- `src/extension/model/providerRegistry.ts` 的真实 DeepSeek 路径默认创建 ReAct runner；fake 路径不变。
- `scripts/codeExplorationE2e.js` 的真实用户问题和状态 oracle 已更新为 ReAct 流程。

## 自动化验证

执行：

```powershell
npm test -- --run
npm run typecheck
npm run compile
git diff --check
```

结果：`44` 个测试文件、`238` 个测试用例全部通过；类型检查、构建和 diff 检查均退出 0。定向测试覆盖：

- 工具 schema 和 OpenAI wire 消息序列化。
- 流式 tool-call delta 聚合、非法 JSON、重复 ID 和空响应。
- assistant tool call 与同 ID tool result 的消息顺序。
- `exploreCode` 输入上限、额外字段、空命中、搜索异常和取消。
- 生产两轮链路：模型英文 query 触发一次搜索，第二轮得到 observation 并返回中文 final。
- E2E oracle 要求 `Planning step 1 -> Running tool exploreCode -> Planning step 2 -> Done`。

## 真实宿主验证

启动命令：

```powershell
npm run debug:vscode
```

已确认：

- 只存在一个 LoopAgent Extension Development Host。
- `extensionDevelopmentPath` 指向当前功能 worktree。
- 固定 user-data、extensions 目录和 CDP 端口 `9333` 被复用。
- CDP 页面标题包含 `[Extension Development Host]`。
- 真实 Webview 已选择 `DeepSeek v4 Flash` 并提交问题：`谁负责把代码上下文加入模型请求？请列出关键源码文件和函数。`

实际结果：

```text
LoopAgent run failed: DeepSeek API key is not configured
```

该失败发生在远端模型请求之前，因此当前证据不能证明真实 DeepSeek 返回了原生 `tool_calls`，也不能证明真实最终回答。它是调试 profile 的外部配置缺失，不是自动化测试发现的协议或 runner 失败。

## 待完成验收

1. 在当前唯一调试窗口执行 `LoopAgent: Set Model API Key`，只写入 VS Code SecretStorage。
2. 原地刷新窗口，不启动第二个 Extension Development Host。
3. 重新执行 `npm run test:e2e:code-exploration`。
4. 通过标准：过程包含 `Running tool exploreCode`，最终回答引用真实源码文件/符号，且命令退出 0。

验证记录不包含 API key、完整请求正文或完整源码 observation。
