# 增量代码索引与 Tree-sitter Runtime 设计

## 背景

当前代码智能链路已经形成最小闭环：

```text
providerRegistry
  -> createVsCodeWorkspaceIntelligence
  -> workspace.findFiles
  -> createWorkspaceIntelligence
  -> buildCodeIntelligencePrompt(task)
  -> modelRunner system prompt
```

这条链路可以把真实 VS Code 工作区源码搜索结果注入模型上下文，但仍有两个限制：

1. 每次模型请求都会重新读取并抽取工作区文件，缺少增量缓存。
2. `ParserRuntime` 只有抽象类型，尚未接入真实 Tree-sitter runtime 和 grammar wasm。

本轮目标是把现有最小闭环升级为可复用的内存增量索引，并接入 Tree-sitter runtime 作为解析层基础。

## 目标

1. `WorkspaceIntelligence` 缓存每个文件的抽取结果，文件内容未变化时不重复执行 language adapter。
2. `createVsCodeWorkspaceIntelligence` 使用 VS Code `FileSystemWatcher` 标记 create/change/delete 事件，后续查询只重读脏文件。
3. `ParserRuntime` 接入 `web-tree-sitter`，支持 TypeScript、TSX、JavaScript、JSX、Python 的 wasm grammar 加载。
4. Tree-sitter 解析失败时降级为空 `tree`，保留现有轻量抽取器，不阻塞模型调用。
5. `npm run compile` 必须把 parser runtime wasm 和 grammar wasm 复制到 `dist/tree-sitter/`，避免 Extension Host 运行时找不到资产。

## 非目标

1. 本轮不做 SQLite 持久化。
2. 本轮不把语义图直接暴露给 Webview UI。
3. 本轮不做框架专用补边。
4. 本轮不完整重写 TS/JS/Python adapter 的抽取逻辑；adapter 可以继续使用现有轻量抽取逻辑，只接收真实 `ParsedSource.tree`。
5. 本轮不保证 Tree-sitter query 覆盖所有语言语义关系。

## 架构

### 增量索引层

`workspaceIntelligence.ts` 新增按文件缓存：

```text
file.path + contentHash
  -> ExtractionResult
  -> diagnostics
```

每次 `buildCodeIntelligencePrompt(query)` 仍重新组装内存图、搜索索引和解析边，但只对内容变化的文件重新执行 parser/runtime 和 language adapter。这样避免引入复杂的图内删除和跨文件边局部重算，同时保证结果一致。

### VS Code 工作区层

`vscodeWorkspaceIntelligence.ts` 维护两类缓存：

```text
sourceCache: relativePath -> text
dirtyPaths: Set<relativePath>
deletedPaths: Set<relativePath>
```

查询时：

1. `workspace.findFiles` 获取当前可索引文件集合。
2. 未变化文件从 `sourceCache` 读取，不调用 `workspace.fs.readFile`。
3. 新文件或脏文件重新读取、过滤大小、更新缓存。
4. watcher delete 事件移除缓存。

如果测试或运行环境没有 `createFileSystemWatcher`，仍退化为当前行为，但 `WorkspaceIntelligence` 的抽取缓存仍可避免重复解析同内容文本。

### Tree-sitter Runtime

新增 `src/extension/intelligence/parser/treeSitterRuntime.ts`：

```text
createTreeSitterParserRuntime({
  wasmDirectory?: string;
  parserWasmPath?: string;
  grammarWasmDirectory?: string;
  languageWasmPaths?: Partial<Record<string, string>>;
})
```

默认运行时从 `dist/tree-sitter/` 读取：

- `web-tree-sitter.wasm`
- `tree-sitter-typescript.wasm`
- `tree-sitter-tsx.wasm`
- `tree-sitter-javascript.wasm`
- `tree-sitter-python.wasm`

测试可以传入 `node_modules` 下的 wasm 路径，避免依赖编译产物。

### 语义上下文预算评估层

真实 DeepSeek 复测证明完整函数体和类方法范围可以提升回答准确性，但也暴露出新的成本问题：每次 prompt 会携带 7 到 14 个源码片段，单条 system message 可达到 12k 到 25k 字符。相对 CodeGraph 风格的图查询，这仍然偏长。

新增 `contextBudget.ts` 作为独立预算评估层，按用户问题意图选择不同上下文 profile：

| 模式 | 触发场景 | 上下文策略 |
| --- | --- | --- |
| `graph-summary` | 架构、调用链、依赖、影响面、关系类问题 | 只返回入口符号、相关符号和关系边，不展开源码片段。 |
| `focused-source` | 解释“如何实现/如何串联/如何解析”的问题 | 最多返回 5 个源码片段，支持 2 跳调用链展开和查询词 fallback。 |
| `expanded-source` | 修改代码、修复 bug、调试、实现功能类问题 | 给更大的源码片段预算，但仍限制入口数量、相关节点、关系边和源码行数。 |

预算层不改变 Webview 协议，也不改变 model provider 调用链。它只影响 `createCodeIntelligenceContext` 的内部召回与渲染：

```text
query
  -> evaluateCodeIntelligenceBudget(query, maxPromptChars)
  -> searchIndex.search(query, profile.maxEntryNodes)
  -> expandFromNodes(..., profile.expandDepth)
  -> slice relatedNodes / edges / snippets by profile
  -> renderCodeIntelligencePrompt(result)
```

当前实现仍是启发式分类，优先解决 token 成本问题。后续可以把分类依据升级为更明确的用户意图枚举，或者让模型 runner 在请求层传入任务类型。

DeepSeek 预算层复测后补充了两个细节：

1. TypeScript adapter 支持 `function*` 和 `async function*`，并修正多行 destructuring 参数、类型字面量中的 `{}` 对函数体范围的干扰。
2. 当用户问题包含 `assistantDelta` 时，预算层会把 `contentDelta`、`reasoningDelta` 作为实现相关词参与 fallback 片段选择，避免只返回上游 wrapper 而漏掉真实事件映射。

### 扩展生命周期

`LoopAgentChatViewProvider` 在实例创建时构造一次 `WorkspaceIntelligence`：

```text
LoopAgentChatViewProvider
  -> createTreeSitterParserRuntime()
  -> createVsCodeWorkspaceIntelligence(vscode, { parserRuntime })
  -> createConfiguredAgentRunner(..., { workspaceIntelligence })
```

这样同一个侧边栏会话内的多次 `startTask` 复用同一个源码缓存、抽取缓存和 watcher 脏标记集合。`providerRegistry` 仍保留默认创建路径，便于测试、独立调用和未来非侧边栏入口复用。

### 构建资产

`esbuild.js` 在非 watch 构建和 watch 启动时都要复制 wasm 资产：

```text
node_modules/web-tree-sitter/web-tree-sitter.wasm
node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm
node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm
node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm
node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm
  -> dist/tree-sitter/
```

## 数据流

```text
modelRunner request.task
  -> providerRegistry.systemPromptProvider(request)
  -> workspaceIntelligence.buildCodeIntelligencePrompt(task)
  -> ensureWorkspaceSourcesFresh()
  -> parse changed files with Tree-sitter when available
  -> extract symbols with existing language adapter
  -> reuse cached extraction for unchanged files
  -> rebuild graph/search index from extraction snapshots
  -> evaluate context budget profile by query intent
  -> render code intelligence prompt
```

## 失败降级

- Tree-sitter 初始化失败：记录 warning diagnostic，`ParsedSource.tree = undefined`，继续走轻量抽取。
- 单个 grammar 加载失败：只影响该语言，其他语言继续使用 Tree-sitter。
- 文件读取失败：记录 warning diagnostic，跳过该文件。
- watcher 不可用：不启用脏文件事件，查询时仍通过 `findFiles` 和缓存运行。
- wasm 资产缺失：`npm run compile` 应失败；运行时缺失则降级为无 tree。

## 测试策略

1. `workspaceIntelligence.test.ts`
   - 同内容第二次查询不重复调用 parser/runtime 或 adapter。
   - 文件内容变化后只重新抽取变化文件。
2. `vscodeWorkspaceIntelligence.test.ts`
   - watcher change 事件后只重读脏文件。
   - watcher delete 事件后 prompt 不再包含删除文件内容。
3. `treeSitterRuntime.test.ts`
   - 使用真实 wasm 解析 TypeScript 和 Python，`ParsedSource.tree` 非空。
   - 不支持语言或缺 grammar 时返回 diagnostic 并降级。
4. `extensionWorkspaceIntelligence.test.ts`
   - 连续两次 chat run 复用同一个 `WorkspaceIntelligence` 实例。
5. `vscodeDebugScript.test.ts`
   - 保持调试宿主启动路径不回退。
6. `codeIntelligenceContext.test.ts`
   - 架构/调用链问题走 `graph-summary`，不展开源码。
   - 解释实现问题走 `focused-source`，只展开少量源码。
   - 修改/调试问题走 `expanded-source`，给更大源码预算。
   - `assistantDelta` 查询能保留 `contentDelta`、`reasoningDelta` 的实现片段。
7. `typescriptAdapter.test.ts`
   - `function*`、`async function*` 和多行 destructuring 参数函数范围正确覆盖完整函数体。
8. 全量验证
   - `npm test`
   - `npm run typecheck`
   - `npm run compile`

## 已知取舍

本轮采用“抽取结果增量缓存 + 每次查询重组图”的方式，而不是直接在图里做节点/边局部删除。这样内存和 CPU 成本仍然可控，且能避免跨文件引用解析的局部一致性问题。后续如果仓库规模继续扩大，再引入 SQLite 或图快照持久化。

## 实施记录

本轮已经完成：

1. `scripts/treeSitterAssets.js` 和 `esbuild.js` 复制 Tree-sitter runtime/grammar wasm 到 `dist/tree-sitter/`。
2. `treeSitterRuntime.ts` 接入 `web-tree-sitter`，支持 TypeScript、TSX、JavaScript、JSX、Python。
3. `workspaceIntelligence.ts` 基于 `file.path + contentHash` 缓存抽取结果。
4. `vscodeWorkspaceIntelligence.ts` 基于 `FileSystemWatcher` 维护源码缓存、脏文件集合和删除集合。
5. `providerRegistry.ts` 默认把 Tree-sitter parser runtime 注入 VS Code workspace intelligence。
6. `extension.ts` 在 `LoopAgentChatViewProvider` 生命周期内复用一个 workspace intelligence 实例，避免每次 chat run 重建索引缓存。
7. `contextBudget.ts` 增加语义上下文预算评估层，让架构类、解释类、修改类问题走不同上下文 profile。
8. `typescriptAdapter.ts` 支持 generator 函数范围抽取，保证 SSE 流解析这类 `function*` helper 能进入语义图。
