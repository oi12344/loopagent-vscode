# VS Code 工作区代码上下文接入验证记录

## 验证目标

确认真实 VS Code 工作区源码可以被扫描、过滤、索引，并作为 `代码语义索引上下文` 注入到真实模型 runner 的 system prompt 中。

## RED 记录

先新增失败测试：

```powershell
npm test -- --run test/intelligence/vscodeWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
```

失败点符合预期：

- `createVsCodeWorkspaceIntelligence`、`detectWorkspaceLanguageId`、`normalizeWorkspaceRelativePath`、`readSourceRangeFromText` 尚不存在。
- `providerRegistry` 只传入 `runtime context`，未包含 `代码语义索引上下文`。

## GREEN 记录

实现后重跑同一组测试：

```powershell
npm test -- --run test/intelligence/vscodeWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
```

结果：

- 2 个测试文件通过。
- 7 个测试用例通过。

## 后续完整验证命令

本次收尾前还需要执行：

```powershell
npm test -- --run test/intelligence/vscodeWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts test/vscodeDebugScript.test.ts test/intelligence/workspaceIntelligence.test.ts test/intelligence/codeIntelligenceContext.test.ts test/intelligence/codeIntelligencePrompt.test.ts test/modelRunnerContext.test.ts
npm run typecheck
npm run compile
npm run debug:vscode
```

`npm run debug:vscode` 必须复用项目脚本和固定调试目录，不手写新的 `code --extensionDevelopmentPath` 命令。

## VS Code 实机验证记录

第一次真实 DeepSeek 查询返回了“没有访问文件系统能力”的通用回答。根因是 `scripts/start-vscode-debug.ps1` 只通过 `--extensionDevelopmentPath` 加载扩展，没有把 `E:\work\loopagent-vscode` 作为 workspace folder 打开，导致 `workspaceFolders` 为空。

补充测试：

```powershell
npm test -- --run test/vscodeDebugScript.test.ts
```

修复后，脚本会把 `$extensionPath` 作为最后一个参数传给 Code CLI。再次使用 `npm run debug:vscode` 启动调试宿主，并在 Webview 中选择 `DeepSeek v4 Flash` 提问：

```text
请基于当前工作区搜索上下文回答：LoopAgent 模型接入相关代码在哪里？重点说明 src/extension/model/providerRegistry.ts、createDeepSeekProvider、modelRunner 的职责。
```

CDP 读取最后一条 assistant DOM 状态：

```json
{
  "status": "DeepSeek deepseek-v4-flash\nDone",
  "hasProviderRegistry": true,
  "hasCreateDeepSeekProvider": true,
  "hasModelRunner": true,
  "hasNoFilesystemDisclaimer": false,
  "answerLength": 1755
}
```

这说明真实 VS Code 调试宿主中，工作区源码已经进入模型上下文，模型返回能够引用当前仓库的模型接入代码。

## 已知限制

- 默认 `fake` provider 不走真实模型上下文链路。
- 真实 DeepSeek 返回依赖本机已配置 API key。
- 当前索引仍为请求时全量内存重建，后续再做增量缓存。
