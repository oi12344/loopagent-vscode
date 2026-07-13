# 生产 ReAct 与代码搜索工具验证记录

> 日期：2026-07-13
>
> 分支：`codex/production-react-code-search`
>
> 结论：实现、自动化门禁和真实 DeepSeek ReAct 用户路径均通过验收。

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

结果：`45` 个测试文件、`239` 个测试用例全部通过；类型检查、构建和 diff 检查均退出 0。根目录 Vitest 配置显式排除 `.worktrees/**`，避免并存的隔离 worktree 被重复扫描。定向测试覆盖：

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

API key 通过 `LoopAgent: Set Model API Key` 写入当前调试 profile 的 VS Code SecretStorage。随后原地执行 `Developer: Reload Window`，没有启动第二个调试窗口。

最终执行：

```text
npm run test:e2e:code-exploration
passed: true
missingStates: []
```

过程包含：

- `Planning step 1`
- `Running tool exploreCode`
- `Planning step 2`
- `Done`

最终回答命中函数：`createConfiguredAgentRunner`、`collectCodeRuntimeContext`、`renderCodeRuntimeContextPrompt`、`createOpenAiReactModelTurn`；命中源码路径：

- `src/extension/model/providerRegistry.ts`
- `src/extension/runtime/vscodeRuntimeContext.ts`
- `src/extension/runtime/codeRuntimeContext.ts`
- `src/extension/runtime/contextPrompt.ts`

命令退出 0，截图保存于忽略目录 `.artifacts/code-exploration-e2e.png`。首次真实回答错误关联了未被当前生产入口调用的 `modelRunner.ts`；随后收紧 system prompt，要求从当前生产入口追踪并逐条验证调用边。E2E oracle 同时保留两个独立条件：过程必须实际运行 `exploreCode`，答案必须命中当前 runtime 注入链或 semantic-tool 链的真实函数和路径。

验证记录不包含 API key、完整请求正文或完整源码 observation。
