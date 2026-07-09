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
4. `vscodeDebugScript.test.ts`
   - 保持调试宿主启动路径不回退。
5. 全量验证
   - `npm test`
   - `npm run typecheck`
   - `npm run compile`

## 已知取舍

本轮采用“抽取结果增量缓存 + 每次查询重组图”的方式，而不是直接在图里做节点/边局部删除。这样内存和 CPU 成本仍然可控，且能避免跨文件引用解析的局部一致性问题。后续如果仓库规模继续扩大，再引入 SQLite 或图快照持久化。
