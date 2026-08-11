# 模型请求超时实施计划

1. 在 `test/openAiCompatibleClient.test.ts` 增加挂起请求回归用例，并确认当前实现失败。
2. 在 `src/extension/model/openAiCompatibleClient.ts` 合并用户取消与内部超时，覆盖 fetch 和 SSE 读取。
3. 确认超时返回现有 `request_failed` 错误分类，正常流和 HTTP 错误映射保持不变。
4. 执行定向测试、全量测试、类型检查、构建及 `git diff --check`。

## 完成记录

- 红灯：挂起请求未被客户端中止，测试按预期失败。
- 绿灯：`npm test -- test/openAiCompatibleClient.test.ts`，9 个测试通过。
- 类型检查、构建和 `git diff --check` 已通过。
- 全量测试存在既有阻塞：`test/agent/runCommandProgress.test.ts` 超过 60 秒未结束；排除该文件后仍有 17 个与本次模型超时无关的既有失败。
- `npm run debug:vscode` 已启动唯一调试窗口并成功激活开发扩展；调试配置存在既有 `safeStorage.decryptString` 密文解密错误，未执行真实模型 E2E。
