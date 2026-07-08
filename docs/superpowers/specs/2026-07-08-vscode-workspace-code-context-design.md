# VS Code 工作区代码上下文接入补充设计

## 背景

多语言代码智能索引已经具备内存语义图、名称搜索、TS/JS 与 Python 基础抽取、引用解析和 prompt 渲染能力，但 `providerRegistry.ts` 之前只创建 `createEmptyWorkspaceIntelligence()`。这意味着模型调用链路虽然有代码智能注入点，真实 VS Code 工作区里的搜索结果并没有进入模型 system prompt。

本补充设计把已有 `WorkspaceIntelligence` 接到 Extension Host 的 VS Code 工作区文件 API 上，形成“按用户问题搜索源码、整理成代码语义上下文、再发给模型”的最小闭环。

## 目标

1. 在真实 VS Code Extension Host 中使用 `workspace.findFiles` 扫描当前工作区源码。
2. 支持第一批可解析文件：`.ts`、`.tsx`、`.js`、`.jsx`、`.py`。
3. 复用现有 `createWorkspaceIntelligence`、语言 adapter、搜索索引、语义图和 prompt renderer。
4. 在 `createConfiguredAgentRunner` 的 `systemPromptProvider(request)` 中组合：
   - `collectVsCodeRuntimeContext()` 渲染出的当前编辑器/标签/diagnostics 上下文。
   - `workspaceIntelligence.buildCodeIntelligencePrompt(request.task)` 渲染出的代码语义索引上下文。
5. 保持失败降级：代码智能失败时不影响已有 runtime context 和模型调用。

## 非目标

1. 本次不做增量索引，仍按每次模型请求重建内存索引。
2. 本次不引入 Tree-sitter runtime、grammar wasm 或 SQLite。
3. 本次不改变 `fakeAgentRunner`；默认 fake provider 仍用于本地 UI smoke test，不代表真实模型上下文链路。
4. 本次不把语义图暴露给 Webview UI。

## 数据流

```text
createConfiguredAgentRunner
  -> createVsCodeWorkspaceIntelligence(vscode)
  -> workspace.findFiles
  -> 路径/语言/大小过滤
  -> createWorkspaceIntelligence
  -> buildCodeIntelligencePrompt(task)
  -> runtime prompt + code intelligence prompt
  -> createModelRunner
  -> provider.stream(messages)
```

`vscodeWorkspaceIntelligence.ts` 只负责把 VS Code 工作区文件转换为 `WorkspaceSourceFile[]`，不直接实现语义分析。语义分析仍由 `workspaceIntelligence.ts` 及其下游模块负责。

## 安全与预算

路径过滤继续排除：

- `.git`
- `node_modules`
- `dist`
- `.local-vscode-*`
- `.env` 与 `.env.*`
- 文件名包含 `secret`、`token`、`api_key`、`apikey`、`key` 等敏感词的文件

第一层 VS Code 扫描保护：

- `findFiles` 默认最多返回 `512` 个源码文件。
- 单文件读取后默认超过 `100000` 字节即跳过，不进入索引。

第二层语义索引保护仍由 `WorkspaceIntelligenceBudgets` 执行，包括节点数、边数、未解析引用数和 prompt 字符预算。

## 测试策略

新增测试覆盖两层行为：

1. `test/intelligence/vscodeWorkspaceIntelligence.test.ts`
   - 文件路径过滤。
   - 文件扩展名到 `languageId` 的映射。
   - 工作区相对路径归一化。
   - 基于 fake VS Code workspace API 构建代码语义 prompt，并确认 `.env` 不进入上下文。

2. `test/providerRegistryCodeContext.test.ts`
   - 模拟 DeepSeek provider 捕获发给模型的 messages。
   - 注入 fake VS Code workspace API。
   - 验证 system prompt 同时包含 runtime context 和 `代码语义索引上下文`。
   - 验证命中的 `createDeepSeekProvider` 与相对路径进入 prompt。

## 真实 VS Code 验证边界

`npm run debug:vscode` 启动的 Extension Development Host 可以验证真实窗口、面板、消息流和编译产物加载。要验证“真实模型基于搜索上下文返回”，需要调试宿主中选择 `deepseek` provider，并且本机已配置 DeepSeek API key。缺少 API key 时，只能验证上下文注入链路和 UI 事件流，不能证明远端模型返回。

调试脚本必须同时满足两件事：

1. 使用 `--extensionDevelopmentPath` 加载当前扩展。
2. 把项目根目录作为 VS Code 打开的 workspace folder。

如果只加载扩展但不打开项目根目录，`vscode.workspace.workspaceFolders` 会为空，`createVsCodeWorkspaceIntelligence` 无法扫描当前仓库源码，真实模型会退化为没有代码上下文的通用回答。
