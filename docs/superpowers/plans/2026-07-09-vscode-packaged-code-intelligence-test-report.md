# VS Code 打包宿主与复杂问题代码索引测试报告

## 测试对象

- 分支：`code-intel-incremental-treesitter`
- 提交：`fd5a0c6 docs: verify incremental tree-sitter code intelligence`
- 工作区：`C:\Users\msi\.config\superpowers\worktrees\loopagent-vscode\code-intel-incremental-treesitter`
- 扩展入口：`package.json` 的 `main = ./dist/extension.js`
- 测试日期：2026-07-09

## 测试目标

1. 验证当前代码可以打包到 `dist/` 并由 VS Code Extension Development Host 加载。
2. 验证 Tree-sitter wasm 资产已复制到 `dist/tree-sitter/`。
3. 基于当前源码结构生成 5 个复杂问题，检查代码索引 prompt 是否能返回关键结构上下文。
4. 记录测试过程、命令、结果和当前缺口。

## 测试过程

### 1. 构建与关键自动化验证

执行命令：

```powershell
npm run compile
npm run typecheck
npm test -- test/extensionWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/intelligence/treeSitterRuntime.test.ts
```

结果：

- `npm run compile`：通过，`node esbuild.js` 退出码为 0。
- `npm run typecheck`：通过，`tsc --noEmit -p ./` 退出码为 0。
- 关键自动化测试：4 个测试文件通过，14 个用例通过。

关键自动化测试覆盖：

1. `extensionWorkspaceIntelligence.test.ts`：侧边栏连续 chat run 复用同一个 workspace intelligence 实例。
2. `providerRegistryCodeContext.test.ts`：DeepSeek provider 路径注入 Tree-sitter parser runtime 和 workspace intelligence。
3. `vscodeWorkspaceIntelligence.test.ts`：VS Code watcher change/delete 驱动源码缓存刷新。
4. `treeSitterRuntime.test.ts`：真实 wasm 解析 TypeScript、Python，不支持语言时降级。

### 2. wasm 资产检查

执行命令：

```powershell
Get-ChildItem dist/tree-sitter | Select-Object -ExpandProperty Name
```

结果包含：

- `web-tree-sitter.wasm`
- `tree-sitter-typescript.wasm`
- `tree-sitter-tsx.wasm`
- `tree-sitter-javascript.wasm`
- `tree-sitter-python.wasm`

### 3. VS Code Extension Development Host 启动验证

执行命令：

```powershell
npm run debug:vscode
```

脚本输出：

```text
已启动单一 LoopAgent VS Code 调试窗口。
extensionDevelopmentPath: C:\Users\msi\.config\superpowers\worktrees\loopagent-vscode\code-intel-incremental-treesitter
user-data-dir: C:\Users\msi\.config\superpowers\worktrees\loopagent-vscode\code-intel-incremental-treesitter\.local-vscode-user-data
extensions-dir: C:\Users\msi\.config\superpowers\worktrees\loopagent-vscode\code-intel-incremental-treesitter\.local-vscode-extensions
remote-debugging-port: 9333
```

随后检查远程调试端口：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9333/json/version
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9333/json/list
```

结果：

- 远程调试端口 `9333` 可访问。
- VS Code 版本信息包含 `Code/1.121.0`、`Chrome/142.0.7444.265`。
- 调试目标包含 `[Extension Development Host] Welcome - code-intel-incremental-treesitter - Visual Studio Code [Administrator]`。
- `Code.exe` 进程命令行包含当前 worktree 的 `--extensionDevelopmentPath`。

日志检查：

```powershell
Get-ChildItem .local-vscode-user-data\logs -Recurse -File |
  Select-String -Pattern 'LoopAgent','loopagent','extensionDevelopmentPath','error','Tree-sitter','Cannot find module','activate' -SimpleMatch -List
```

结果：未发现 LoopAgent 加载错误、Tree-sitter 错误或模块缺失错误。

## 五个复杂问题测试

### 测试方式

为了隔离“索引质量”和“外部模型质量”，本轮没有调用 DeepSeek API，也没有使用默认 fake provider 的占位回答作为索引质量依据。测试通过临时 Vitest 用例直接调用：

```text
createWorkspaceIntelligence
  -> createTreeSitterParserRuntime(node_modules wasm)
  -> read src/**/*.ts, src/**/*.tsx
  -> buildCodeIntelligencePrompt(question)
```

每题检查：

1. `WorkspaceIntelligence.getStatus()` 是否为 `ready`。
2. diagnostics 是否为空。
3. 去掉查询原文后，prompt 上下文是否包含预期文件、符号或关键实现词。

### 问题与结果

| 编号 | 问题 | 结果 | 命中情况 |
| --- | --- | --- | --- |
| Q1 | `providerRegistry.ts` 里的 `createConfiguredAgentRunner` 如何把 `collectVsCodeRuntimeContext`、`renderCodeRuntimeContextPrompt`、`workspaceIntelligence` 和 `createModelRunner` 串成模型 system prompt？ | 部分命中 | 状态 `ready`，diagnostics 为空，prompt 长度 7496。5 个预期项命中 3 个；缺少 `createModelRunner`、`collectVsCodeRuntimeContext`。 |
| Q2 | `extension.ts` 里的 `LoopAgentChatViewProvider.startRun` 怎样复用 `createVsCodeWorkspaceIntelligence` 和 `createTreeSitterParserRuntime` 生成的 `workspaceIntelligence`？ | 部分命中 | 状态 `ready`，diagnostics 为空，prompt 长度 9847。5 个预期项命中 2 个；缺少 `src/extension.ts`、`LoopAgentChatViewProvider`、`startRun`。 |
| Q3 | `createVsCodeWorkspaceIntelligence` 如何用 `sourceCache`、`dirtyPaths`、`deletedPaths` 和 `FileSystemWatcher` 处理 change/delete 增量刷新？ | 部分命中 | 状态 `ready`，diagnostics 为空，prompt 长度 7345。5 个预期项命中 2 个；缺少 `sourceCache`、`dirtyPaths`、`deletedPaths`。 |
| Q4 | `createTreeSitterParserRuntime` 如何通过 `web-tree-sitter`、`LANGUAGE_WASM_BY_ID`、`parserWasmPath` 和 `grammarWasmDirectory` 加载多语言 grammar？ | 完整命中 | 状态 `ready`，diagnostics 为空，prompt 长度 9514。5 个预期项全部命中。 |
| Q5 | `createOpenAiCompatibleClient` 的 `streamChatCompletion` 如何解析 SSE、处理 `parseServerSentEvents`、`mapChunkEvents`、`reasoningDelta`、`contentDelta` 和 abort signal？ | 完整命中 | 状态 `ready`，diagnostics 为空，prompt 长度 13960。6 个预期项全部命中。 |

## 结论

VS Code 打包宿主加载验证通过：

1. `dist/extension.js` 可以由 Extension Development Host 加载。
2. 远程调试端口 `9333` 可访问。
3. 当前 worktree 的 Extension Development Host 进程存在。
4. `dist/tree-sitter/` 包含运行所需的 5 个 wasm 文件。
5. 日志未发现 LoopAgent 加载错误、Tree-sitter 错误或模块缺失错误。

代码索引复杂问题验证结果：

1. 5 个问题中 2 个完整命中，3 个部分命中。
2. 所有问题的索引状态均为 `ready`，diagnostics 均为空，说明索引流程本身没有运行失败。
3. 部分命中的主要问题不是 Tree-sitter 加载失败，而是当前 prompt 构造只给符号节点返回较窄源码范围，函数体内部调用和局部状态变量不稳定进入最终 prompt。

## 风险与后续建议

1. 对“函数体如何串联多个调用”的问题，应扩展 TypeScript adapter 的函数/方法 `endLine` 计算，让源码片段覆盖完整函数体，而不是只覆盖声明行。
2. 对 `sourceCache`、`dirtyPaths`、`deletedPaths` 这种函数内部局部状态，应增加词法级补充索引或文件级 fallback snippet。
3. 对类方法查询，如 `LoopAgentChatViewProvider.startRun`，应改善类名、方法名和文件名组合查询的排序，避免只命中被调用的工厂函数。
4. 后续如果要测试真实模型回答质量，需要配置 DeepSeek API key 后在 Extension Development Host 中选择 DeepSeek provider；本报告只验证代码索引上下文，不评价外部模型回答。
