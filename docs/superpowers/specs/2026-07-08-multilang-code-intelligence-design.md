# 多语言 AST 解析与代码语义图设计

## 背景

LoopAgent 目前在模型调用前会收集一次 `CodeRuntimeContext`，内容主要来自 VS Code 当前状态：活动编辑器、可见编辑器、打开标签、少量项目文件和 diagnostics。这个机制能让模型理解当前工作区，但它还不能回答“某个功能如何跨文件流转”“某个函数被谁调用”“某个模块相关代码在哪里”等结构化问题。

如果继续依赖模型自行使用 `grep`、`rg` 或打开大量文件，会带来明显 token 浪费，也容易把无关文件塞进 prompt。需要新增一层代码智能索引，把源码先解析成结构化语义图，再按用户问题返回少量相关符号、关系和源码片段。

本设计参考 CodeGraph 的核心思想，但不复刻其完整产品能力。LoopAgent 应自研轻量内核：开源 parser 只负责产生 AST/CST，语义抽取、引用解析、图建模、图查询和 prompt 压缩由 LoopAgent 自己实现。

## 目标

1. 建立多语言 AST/CST 解析入口，为 TS/JS、Python、Go、Java、Rust 等语言预留统一扩展点。
2. 建立统一代码语义图模型，屏蔽不同语言的语法差异。
3. 支持从源码抽取文件、模块、类、函数、方法、类型、导入、调用等节点和边。
4. 支持按用户问题查询相关符号，并扩展 1 到 2 跳关系，生成低 token 上下文。
5. 优先以 prompt 注入方式接入现有模型调用链，后续再扩展为 agent 可调用工具。

## 非目标

1. 第一阶段不实现完整 CodeGraph 级别的多语言语义能力。
2. 第一阶段不引入图数据库。
3. 第一阶段不实现框架专用补边，如 React render、NestJS route、Spring controller 等。
4. 第一阶段不做自动代码修改工具。
5. 第一阶段不把语义图暴露给 Webview UI。
6. 第一阶段不要求所有语言达到同等解析精度。

## 架构分层

整体链路如下：

```text
源码文件
  -> Parser Runtime
  -> Language Adapter
  -> Semantic Extraction
  -> Reference Resolution
  -> Unified Semantic Graph
  -> Graph Query
  -> Prompt Context
```

建议新增模块：

```text
src/extension/intelligence/
  parser/
    parserRuntime.ts
    treeSitterRuntime.ts
    languageRegistry.ts

  languages/
    languageAdapter.ts
    typescriptAdapter.ts
    pythonAdapter.ts
    goAdapter.ts
    javaAdapter.ts
    rustAdapter.ts

  graph/
    graphTypes.ts
    semanticGraph.ts
    searchIndex.ts
    graphTraverser.ts

  resolution/
    importResolver.ts
    referenceResolver.ts

  context/
    codeIntelligenceContext.ts
    codeIntelligencePrompt.ts

  workspaceIntelligence.ts
```

`workspaceIntelligence.ts` 是现有模型运行链路的唯一入口。`providerRegistry.ts` 和 `modelRunner.ts` 不直接依赖 Tree-sitter、AST 或具体语言 adapter。

## Parser Runtime

多语言解析优先使用 Tree-sitter 生态：

- `web-tree-sitter`：提供 WASM parser runtime。
- grammar wasm：按语言懒加载。

Parser runtime 只负责：

1. 根据 `languageId` 或文件扩展名选择 grammar。
2. 加载并缓存 parser。
3. 将源码解析为 `ParsedSource`。
4. 捕获解析错误并返回结构化 diagnostic。

抽象接口：

```ts
type ParserRuntime = {
  parse(filePath: string, languageId: string, text: string): Promise<ParsedSource>;
};

type ParsedSource = {
  filePath: string;
  languageId: string;
  text: string;
  tree: unknown;
  diagnostics: IndexDiagnostic[];
};
```

语义图和查询层不得直接访问 Tree-sitter API。这样后续如果某种语言更适合使用官方 parser，也可以新增 parser adapter，而不用改 Graph Core。

## Language Adapter

每种语言通过 adapter 把 AST/CST 转成统一抽取结果。

```ts
type LanguageAdapter = {
  id: string;
  languageIds: string[];
  extensions: string[];
  extract(parsed: ParsedSource): ExtractionResult;
};

type ExtractionResult = {
  nodes: CodeNode[];
  edges: CodeEdge[];
  importBindings: ImportBinding[];
  unresolvedReferences: UnresolvedReference[];
  diagnostics: IndexDiagnostic[];
};
```

语言差异只允许存在于 adapter 和 resolver 内部。例如：

- TypeScript/JavaScript：解析 `import/export`、函数、类、方法、类型别名、调用表达式。
- Python：解析 module、`import x`、`from x import y`、类、函数、方法、装饰器。
- Go：解析 package、import、函数、receiver method、struct、interface。
- Java：解析 package、import、class、interface、enum、method、constructor、field、extends、implements。
- Rust：解析 mod、use、struct、enum、trait、impl、function、method。

## 统一语义图模型

上层图模型保持语言无关。

```ts
type CodeNodeKind =
  | "file"
  | "module"
  | "package"
  | "namespace"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "enum"
  | "type"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "import"
  | "export";

type CodeEdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "type_of"
  | "returns"
  | "instantiates";
```

节点模型：

```ts
type CodeNode = {
  id: string;
  kind: CodeNodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  signature?: string;
  isExported?: boolean;
  metadata?: Record<string, unknown>;
};
```

边模型：

```ts
type CodeEdge = {
  id: string;
  source: string;
  target: string;
  kind: CodeEdgeKind;
  filePath?: string;
  line?: number;
  column?: number;
  confidence: "exact" | "probable" | "heuristic";
  metadata?: Record<string, unknown>;
};
```

第一阶段只要求稳定生成以下关系：

- `contains`：文件包含符号，类包含方法。
- `imports`：文件或 import 节点导入其他文件或符号。
- `exports`：文件导出符号。
- `calls`：函数或方法调用另一个已解析符号。
- `references`：不能更精确分类但能解析到目标符号的引用。

## 未解析引用

抽取阶段不强行解析所有跨文件关系。adapter 先记录未解析引用，全仓库符号表构建后再由 resolver 统一处理。

```ts
type UnresolvedReference = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: "calls" | "references" | "type_of" | "extends" | "implements";
  filePath: string;
  line: number;
  column?: number;
  localScope?: string;
  importSource?: string;
  languageId: string;
  metadata?: Record<string, unknown>;
};
```

解析优先级：

```text
1. 同文件局部定义
2. import binding
3. 当前 class / struct / module 范围
4. exported symbols
5. qualifiedName 精确匹配
6. 全局唯一 name 匹配
7. 保留 unresolved，不生成边
```

这个两阶段设计可以降低错连边概率，也方便后续为不同语言补充 resolver。

## Import Binding

导入关系需要单独建模，避免用文本搜索猜测符号来源。

```ts
type ImportBinding = {
  filePath: string;
  localName: string;
  importedName: string;
  source: string;
  resolvedFilePath?: string;
  isDefault?: boolean;
  isNamespace?: boolean;
  languageId: string;
};
```

不同语言的导入解析规则由语言 resolver 提供，Graph Core 只消费归一化后的 `ImportBinding`。

## 存储策略

第一阶段使用内存索引：

```text
nodesById: Map<string, CodeNode>
nodeIdsByName: Map<string, string[]>
nodeIdsBySegment: Map<string, string[]>
outgoingBySource: Map<string, CodeEdge[]>
incomingByTarget: Map<string, CodeEdge[]>
fileRecords: Map<string, IndexedFileRecord>
unresolvedReferences: UnresolvedReference[]
importBindings: ImportBinding[]
```

后续仓库规模增大后再引入 SQLite。即使引入 SQLite，也不需要图数据库；调用者、被调用者、影响范围和路径查询都可以通过 `edges(source, kind)`、`edges(target, kind)` 索引加 BFS/DFS 实现。

## 搜索索引

语义图需要同时支持结构化查询和自然语言命中。

第一阶段实现名称和 segment 索引：

```text
createConfiguredAgentRunner
  -> create
  -> configured
  -> agent
  -> runner
```

`searchIndex.ts` 负责：

1. 按精确名称查节点。
2. 按 `qualifiedName` 片段查节点。
3. 按 camelCase、snake_case、kebab-case segment 查节点。
4. 降低测试文件、构建产物和低价值文件权重。

## 图查询

第一阶段提供以下查询：

```ts
searchSymbols(query: string): CodeNode[];
readSymbol(symbol: string): CodeIntelligenceResult;
exploreCode(query: string): CodeIntelligenceResult;
getCallers(nodeId: string, depth?: number): CodeSubgraph;
getCallees(nodeId: string, depth?: number): CodeSubgraph;
```

`exploreCode(query)` 是替代 grep 的主入口：

```text
query 分词
  -> name/segment 命中入口节点
  -> 根据 calls/imports/references/contains 扩展 1 到 2 跳
  -> 按文件聚合
  -> 读取符号源码片段
  -> 按预算排序和裁剪
  -> 渲染为模型上下文
```

查询结果不直接输出整个文件，默认只输出符号起止行附近的源码片段和关系摘要。

## 路径与安全过滤

沿用现有 `CodeRuntimeContext` 的安全策略，并集中到共享过滤函数：

排除：

- `.git`
- `node_modules`
- `dist`
- `.local-vscode-*`
- `.env` 和 `.env.*`
- 文件名包含 `secret`、`token`、`api_key`、`apikey`、`key` 等敏感词的文件

语义索引不得读取超大文件。第一阶段应设置单文件大小上限，超过上限只记录 file diagnostic，不解析内容。

## 与现有模型链路集成

当前链路：

```text
providerRegistry
  -> collectVsCodeRuntimeContext
  -> renderCodeRuntimeContextPrompt
  -> modelRunner
```

目标链路：

```text
providerRegistry
  -> collectVsCodeRuntimeContext
  -> workspaceIntelligence.explore(task)
  -> renderCombinedRuntimePrompt
  -> modelRunner
```

需要调整 `modelRunner` 的系统 prompt provider：

```ts
systemPromptProvider?: (request: AgentRunRequest) => Promise<string>;
```

这样 `WorkspaceIntelligence` 可以直接使用用户 task 作为查询入口。

如果语义索引不可用、正在构建、解析失败或超时，模型调用必须回退到现有 `CodeRuntimeContext`。失败信息可以通过 `agentEvent` 通知用户，但不得阻塞普通聊天。

## 增量更新

第一阶段可以在首次请求时全量建立内存索引。第二阶段加入：

1. 文件保存触发单文件重建。
2. 文件删除移除相关节点和边。
3. 文件 hash/mtime 判断是否跳过。
4. 后台 debounce，避免频繁重建。
5. 索引状态可查询：`idle`、`indexing`、`partial`、`failed`。

## 实施分期

### M1：模型与内存图

- 定义 `CodeNode`、`CodeEdge`、`UnresolvedReference`、`ImportBinding`。
- 实现 `SemanticGraph`、`SearchIndex`、`GraphTraverser`。
- 用 fixture 测试插入、去重、incoming/outgoing、segment 搜索。

### M2：Tree-sitter runtime

- 接入 `web-tree-sitter`。
- 实现 language registry。
- 支持按语言懒加载 grammar。
- 解析失败返回 diagnostic。

### M3：首批语言 adapter

- 实现 TypeScript/JavaScript adapter。
- 实现 Python adapter。
- 覆盖基础节点、导入、函数/类/方法和调用引用。

### M4：引用解析

- 实现 import binding resolver。
- 实现跨文件 symbol resolver。
- 将可解析的 `UnresolvedReference` 转成 `CodeEdge`。

### M5：查询与上下文渲染

- 实现 `exploreCode`。
- 实现预算化源码片段读取。
- 实现 prompt renderer。

### M6：模型链路接入

- 调整 `systemPromptProvider` 签名。
- 在 `providerRegistry.ts` 组合 VS Code runtime context 和 code intelligence context。
- 失败时回退到现有上下文。

### M7：增量索引

- 文件保存后重建单文件索引。
- 文件删除后清理相关节点和边。
- 加入索引状态和超时保护。

### M8：更多语言与持久化

- 增加 Go、Java、Rust adapter。
- 评估 SQLite 持久化。
- 评估 agent tool calling。

## 验证方式

单元测试：

- parser runtime 能识别和解析支持语言。
- 每个 language adapter 对 fixture 输出稳定节点和引用。
- semantic graph 能正确维护 incoming/outgoing 边。
- resolver 能解析同文件、import、export、唯一名称。
- `exploreCode` 能在预算内返回相关符号和源码片段。
- 敏感路径和超大文件不会进入索引。

集成测试：

- 模型调用能注入 code intelligence context。
- 语义索引失败时仍能正常使用现有 runtime context。
- 对当前仓库询问 `providerRegistry`、`modelRunner`、`CodeRuntimeContext` 相关问题时，不需要大范围 grep，也能命中相关文件和符号。

手动验证：

```powershell
npm test
npm run typecheck
npm run compile
npm run debug:vscode
```

在 Extension Development Host 中执行：

1. 打开 LoopAgent 面板。
2. 提问模型链路相关问题，例如“providerRegistry 如何把 runtime context 注入模型”。
3. 确认回答上下文来自语义索引命中的相关符号，而不是整仓库搜索。

## 技术债记录

1. Tree-sitter grammar wasm 的打包方式需要在实施计划中单独验证，避免 VS Code 扩展发布后找不到 wasm 资源。
2. 第一阶段的跨文件调用解析不会完整处理动态调用、函数作为值传递、反射和框架隐式关系。
3. 第一阶段内存索引适合中小项目；大型仓库需要 SQLite 持久化和分页查询。
4. 多语言 adapter 的精度会逐步提升，不能假设所有语言首版能力一致。
