# DeepSeek 工具历史 Thinking 模式修复计划

## 范围

1. 在 `test/deepseekProvider.test.ts` 增加工具历史收尾请求的回归测试，并确认旧实现失败。
2. 在 DeepSeek Provider 中让整个工具调用链保持 `thinking: disabled`。
3. 最终回答阶段保留工具定义并发送 `tool_choice: none`，防止 DeepSeek 返回 DSML 文本。
4. 对首轮普通 `content` 中的完整 DSML 工具调用做兼容转换，复用现有 ReAct 工具执行链。
5. 运行定向测试、类型检查、构建和差异检查。

## 验收结果

- 回归测试红灯：旧实现发送 `thinking: enabled`，与预期不符。
- 修复后 `npm test -- test/deepseekProvider.test.ts test/openAiCompatibleClient.test.ts` 通过，共 2 个测试文件、16 个用例。
- `npm run typecheck` 与 `npm run compile` 通过。
- `git diff --check` 通过，仅有工作区现存的 LF/CRLF 提示。
- 排除已知长时间用例 `test/agent/runCommandProgress.test.ts` 后执行全量测试，仍有 16 个与本修复无关的既有失败及 1 个临时目录清理错误，涉及 VS Code mock、命令工具、提示词断言和 SQLite 索引；DeepSeek Provider 测试通过。
- DSML 回归测试红灯：`toolChoice: none` 时工具定义为 `undefined`；修复后最终请求保留工具定义，相关模型测试、Provider Registry 契约测试、类型检查和构建通过。
- DSML 修复后的仓库级测试仍为上述 16 个既有失败及 1 个清理错误，没有新增失败。
- 部署后复测确认首轮 `tool_choice: auto` 仍可能返回 DSML；新增截图格式回归测试，旧实现错误返回 `kind: final`，兼容转换后返回 `kind: toolRequests` 并保留参数类型。
