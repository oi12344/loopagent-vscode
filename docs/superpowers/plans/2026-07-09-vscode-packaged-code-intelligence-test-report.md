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
4. 后续应继续用真实模型调用回归代码索引质量，尤其关注跨层调用链和局部状态问题。

## 真实 DeepSeek 对话补充测试与本轮优化

### 优化前问题

2026-07-09 使用用户提供的 DeepSeek API key 做了一轮真实对话测试。API key 只通过当前 PowerShell 进程环境变量传入临时 Vitest 用例，未写入配置文件、报告或源码。

优化前 5 次真实模型调用均完成，说明 DeepSeek API、SSE 解析、`createModelRunner` 消息链路和 `workspaceIntelligence` 构建链路可用。但 Q1、Q2、Q3 的回答质量受索引上下文影响：

1. Q1 没有稳定给出 `createConfiguredAgentRunner` 的完整函数体，模型混入了相邻上下文。
2. Q2 没有稳定命中 `LoopAgentChatViewProvider.startRun` 的类方法语义。
3. Q3 没有稳定包含 `sourceCache`、`dirtyPaths`、`deletedPaths` 等函数内部局部状态。

根因确认：

1. TypeScript adapter 只把函数、类、方法的 `endLine` 设在声明行，最终 prompt 经常只包含声明，不包含函数体。
2. 多行函数签名中的默认参数 `{}` 会提前改变 brace depth，导致作用域结束判断过早。
3. 类方法 `qualifiedName` 缺少类名，`LoopAgentChatViewProvider.startRun` 这类查询排序不稳定。
4. 搜索索引没有对 `qualifiedName` 分词，类名 + 方法名组合查询不稳定。

### 本轮代码优化

已完成优化：

1. `src/extension/intelligence/languages/typescriptAdapter.ts`：为函数、类、方法计算完整源码范围，直到作用域闭合行；多行签名先挂起 scope，等函数体或 class body 的 `{` 出现后再入栈。
2. `src/extension/intelligence/languages/typescriptAdapter.ts`：类方法 `qualifiedName` 改为包含类名，例如 `src/extension.ts::LoopAgentChatViewProvider.startRun`。
3. `src/extension/intelligence/graph/searchIndex.ts`：把 `node.qualifiedName` 纳入分词索引，提升类名、方法名、文件名组合查询的稳定性。
4. `test/intelligence/typescriptAdapter.test.ts`、`test/intelligence/searchIndex.test.ts`、`test/intelligence/workspaceIntelligence.test.ts`：补充覆盖完整函数体范围、类方法排序、Q1/Q2/Q3 风格复杂问题的回归测试。

### 优化后真实 DeepSeek 复测

测试链路：

```text
createModelRunner
  -> createDeepSeekProvider({ model: "deepseek-chat", thinking: "disabled" })
  -> systemPromptProvider
  -> workspaceIntelligence.buildCodeIntelligencePrompt(task)
  -> DeepSeek /chat/completions SSE
  -> assistantDelta / runFinished
```

执行命令形态：

```powershell
$env:DEEPSEEK_API_KEY = "<redacted>"
$env:DEEPSEEK_MODEL = "deepseek-chat"
npm test -- test/manualDeepSeekTranscript.test.ts --reporter=verbose
Remove-Item Env:\DEEPSEEK_API_KEY
Remove-Item Env:\DEEPSEEK_MODEL
```

临时文件 `test/manualDeepSeekTranscript.test.ts` 只用于本次验证和生成报告，测试完成后已删除。

优化后测试结果：

| 编号 | 真实对话结果 | 回答字符数 | prompt 缺失项 | 结论 |
| --- | --- | ---: | --- | --- |
| Q1 | `runFinished=true`，`runFailed` 无，索引状态 `ready`，diagnostics 为空 | 255 | `[]` | 已包含 `createConfiguredAgentRunner` 完整函数体，以及 `createModelRunner`、`collectVsCodeRuntimeContext`、`renderCodeRuntimeContextPrompt`、`workspaceIntelligence.buildCodeIntelligencePrompt`。 |
| Q2 | `runFinished=true`，`runFailed` 无，索引状态 `ready`，diagnostics 为空 | 193 | `[]` | 已包含 `src/extension.ts::LoopAgentChatViewProvider.startRun`、`workspaceIntelligence: this.workspaceIntelligence`、`createConfiguredAgentRunner`、`createVsCodeWorkspaceIntelligence`、`createTreeSitterParserRuntime`。 |
| Q3 | `runFinished=true`，`runFailed` 无，索引状态 `ready`，diagnostics 为空 | 165 | `[]` | 已包含 `createVsCodeWorkspaceIntelligence`、`sourceCache`、`dirtyPaths`、`deletedPaths`、`createFileSystemWatcher`。 |
| Q4 | `runFinished=true`，`runFailed` 无，索引状态 `ready`，diagnostics 为空 | 181 | `[]` | 多语言 wasm grammar 加载问题保持稳定命中。 |
| Q5 | `runFinished=true`，`runFailed` 无，索引状态 `ready`，diagnostics 为空 | 302 | `[]` | OpenAI-compatible SSE 解析问题保持稳定命中。 |

完整记录已落地到 `docs/superpowers/plans/2026-07-09-deepseek-real-dialogue-full-report.md`，包含本次 5 个问题实际发送给 DeepSeek 的完整 `messages`，以及模型返回的完整文本回答。该报告不包含 API key。

### 优化后结论

1. 5 次真实 DeepSeek 调用全部完成，未出现认证失败、余额不足、限流、SSE 解析失败或 abort 异常。
2. 5 个问题的 `workspaceIntelligence` 状态均为 `ready`，diagnostics 均为空。
3. 5 个问题的预期 prompt 关键项均完整命中，Q1/Q2/Q3 的主要上下文缺失问题已修复。
4. 当前 TypeScript adapter 仍是轻量级启发式解析，不等价于完整 TypeScript AST；非常规写法仍可能需要后续用 tree-sitter AST 做更严格的范围计算。

## 语义上下文预算层补充优化

### 背景

优化后真实 DeepSeek 复测解决了“上下文不准”的问题，但从完整 transcript 反推 system prompt 长度后发现，语义索引上下文仍偏长：

| 编号 | system prompt 字符数 | 粗略 token | 源码片段数 |
| --- | ---: | ---: | ---: |
| Q1 | 16,974 | 约 5.3k | 12 |
| Q2 | 16,024 | 约 5.0k | 12 |
| Q3 | 24,761 | 约 7.7k | 14 |
| Q4 | 12,214 | 约 3.8k | 7 |
| Q5 | 16,055 | 约 5.0k | 10 |

这说明当前实现已经比 `grep` 裸塞结果更准确，但相对 CodeGraph 风格的图查询仍然不够省 token。后续优化方向应从“多给源码保证命中”转为“先给结构摘要，必要时再展开源码”。

### 代码调整

新增 `src/extension/intelligence/context/contextBudget.ts`，在 `createCodeIntelligenceContext` 内根据 query 意图选择上下文 profile：

| 模式 | 适用问题 | 策略 |
| --- | --- | --- |
| `graph-summary` | 架构、调用链、依赖、影响面、关系问题 | 不展开源码片段，只保留入口符号、相关符号和关系边。 |
| `focused-source` | 解释实现、说明流程、如何串联 | 最多展开 5 个源码片段，源码字符预算默认不超过 6,000，支持 2 跳调用链和查询词 fallback。 |
| `expanded-source` | 修改代码、修复 bug、调试、实现功能 | 最多展开 6 个源码片段，源码字符预算默认不超过 6,000。 |

同时限制入口符号数、相关符号数、关系边数和单片段行数，避免少量大函数把整个 prompt 撑满。

真实复测期间发现 Q5 的 SSE 流问题需要额外修正：

1. `async function* streamChatCompletion` 和 `function* mapChunkEvents` 原先没有被 adapter 稳定抽取，导致 `reasoningDelta`、`contentDelta` 的函数体不进入 prompt。
2. 多行 destructuring 参数和类型字面量中的 `{}` 会干扰函数体范围计算，导致 generator 函数范围只覆盖签名。
3. `assistantDelta` 是面向 webview 的事件，而 OpenAI-compatible client 内部输出的是 `contentDelta`、`reasoningDelta`；预算层已增加同义 fallback，保留真实事件映射片段。

### 自动化验证

新增 `test/intelligence/codeIntelligenceContext.test.ts` 覆盖：

1. 架构/调用链 query 走 `graph-summary`，`snippets=[]`。
2. 解释实现 query 走 `focused-source`，源码片段数量不超过 profile 限制。
3. 修改/调试 query 走 `expanded-source`，给更大的源码片段预算。
4. `assistantDelta` 查询能补入 `contentDelta`、`reasoningDelta` 实现片段。
5. generator 函数和多行 destructuring 参数函数范围覆盖完整函数体。

已执行：

```powershell
npm test -- test/intelligence/codeIntelligenceContext.test.ts --reporter=verbose
npm test -- test/intelligence/workspaceIntelligence.test.ts test/intelligence/codeIntelligenceContext.test.ts --reporter=verbose
```

结果：相关自动化测试通过，Q1/Q2/Q3 风格的 workspace intelligence 关键命中测试仍然通过。

### 预算层后真实 DeepSeek 复测

执行命令形态：

```powershell
$env:DEEPSEEK_API_KEY = "<redacted>"
$env:DEEPSEEK_MODEL = "deepseek-chat"
npm test -- test/manualDeepSeekBudgetTranscript.test.ts --reporter=verbose
Remove-Item Env:\DEEPSEEK_API_KEY
Remove-Item Env:\DEEPSEEK_MODEL
```

临时文件 `test/manualDeepSeekBudgetTranscript.test.ts` 只用于本次验证和生成报告，测试完成后已删除。

预算层后真实复测结果：

| 编号 | 模式 | system chars | 预算层前 system chars | 降幅 | 源码片段数 | prompt 缺失项 | 回答字符数 |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| Q1 | `focused-source` | 13,799 | 16,974 | 18.7% | 4 | `[]` | 223 |
| Q2 | `focused-source` | 12,584 | 16,024 | 21.5% | 5 | `[]` | 234 |
| Q3 | `focused-source` | 17,660 | 24,761 | 28.7% | 3 | `[]` | 157 |
| Q4 | `focused-source` | 8,070 | 12,214 | 33.9% | 5 | `[]` | 219 |
| Q5 | `focused-source` | 11,829 | 16,055 | 26.3% | 5 | `[]` | 246 |

完整记录已落地到 `docs/superpowers/plans/2026-07-09-deepseek-budgeted-dialogue-test-report.md`，包含预算层后 5 个问题实际发送给 DeepSeek 的完整 `messages`，以及模型返回的完整文本回答。该报告不包含 API key。

结论：

1. 5 次真实 DeepSeek 调用全部完成，`runFailed` 均为空。
2. 5 个问题的 `workspaceIntelligence` 状态均为 `ready`，diagnostics 均为空。
3. 5 个问题的预期 prompt 关键项均完整命中，`promptMissing=[]`。
4. prompt 长度相比预算层前下降 18.7% 到 33.9%。下降幅度低于最初 1k 到 3k token 的理想目标，但已在不损失关键上下文的前提下减少发送内容。
