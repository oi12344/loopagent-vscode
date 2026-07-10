# 真实 AST 语义抽取设计

## 背景

当前代码智能链路已经接入 `web-tree-sitter` 和 TypeScript、TSX、JavaScript、JSX、Python grammar WASM，并使用文件内容哈希缓存抽取结果。上一阶段的目标是先建立 Parser Runtime 和增量缓存，因此 `typescriptAdapter.ts` 与 `pythonAdapter.ts` 仍以逐行正则作为轻量抽取器，`ParsedSource.tree` 虽然能够生成，但没有参与符号、范围、导入和调用关系抽取。

这一状态适合作为 Tree-sitter 运行时脚手架，但不适合作为 SQLite 持久化、结构化切块和向量检索的事实源。静态审查和最小样例验证已经确认以下问题：

1. 有无 `ParsedSource.tree` 时，adapter 产生的结果完全相同。
2. 字符串、注释或模板字符串中的花括号会破坏 TypeScript 函数范围。
3. `service.helper()` 会退化为裸名称 `helper`，并可能错误解析为同文件函数且标记为 `exact`。
4. TypeScript 箭头函数和 Python `async def` 无法形成符号节点。
5. Python 函数与方法的 `endLine` 停留在声明行。
6. `Parser` 与 `Tree` 没有显式释放，存在 WASM 内存持续增长风险。
7. adapter 和 workspace 层重复合并解析诊断。
8. `ImportBinding.resolvedFilePath` 在生产链路没有填充，别名导入无法稳定连边。

本设计在 SQLite 与向量阶段之前增加一个真实 AST 语义抽取阶段，先保证持久化事实的正确性。

## 目标

1. Tree-sitter 可用时，TypeScript 系与 Python adapter 必须从 AST 抽取符号、范围、导入和调用信息。
2. Tree-sitter 不可用或 grammar 加载失败时，保留现有正则抽取作为显式降级路径。
3. 所有 AST 节点范围直接使用 Tree-sitter 的 `startPosition`、`endPosition`，不再通过字符计数推断。
4. 区分裸函数调用和成员调用，禁止把 `service.helper()` 解析为同文件裸函数 `helper()` 的精确调用边。
5. 解析相对导入和常用模块路径，填充 `ImportBinding.resolvedFilePath`。
6. 明确 `Parser`、`Tree` 的所有权和释放位置，索引大仓库时不积累 WASM 资源。
7. 保持现有 `CodeNode`、`CodeEdge`、`ExtractionResult`、`WorkspaceIntelligence` 上层接口稳定。
8. 使用真实 grammar 的自动化测试验证 AST 主路径，并保留降级路径测试。

## 非目标

1. 本阶段不实现 SQLite、FTS、embedding 或向量检索。
2. 本阶段不新增 TypeScript 系和 Python 之外的语言。
3. 本阶段不提供 TypeScript 类型检查器、Python 类型推断或运行时动态派发分析。
4. 本阶段不保证解析 `service.helper()` 的真实接收者类型；缺少类型信息时保留为未解析成员调用，不制造错误精确边。
5. 本阶段不建立完整作用域与控制流图，不解析变量遮蔽、闭包捕获和动态导入的全部语义。
6. 本阶段不做 Tree-sitter 的字符级增量编辑。现有“增量”仍指文件内容未变化时跳过解析，变化文件重新解析。

## 方案比较

### 方案 A：继续增强逐行正则

在现有 adapter 中继续增加字符串过滤、注释过滤、箭头函数、多行签名和不同导入形式的正则。

优点是改动小，降级路径可以快速改善。缺点是规则会持续互相影响，仍然无法可靠处理模板字符串、JSX、嵌套类型、装饰器和 Python 多行语法，也无法利用已经加载的 Tree-sitter。该方案不作为主路径。

### 方案 B：每种语言使用真实 AST，统一输出语义模型

TypeScript 系和 Python adapter 各自遍历 grammar AST，读取字段节点和位置，再输出统一的 `CodeNode`、`CodeEdge`、`ImportBinding` 与 `UnresolvedReference`。两种 adapter 共享少量无语言含义的 AST 遍历和范围转换函数，现有正则实现重命名为 fallback。

优点是符合当前架构，能够复用 WASM grammar，范围和语法结构可靠，同时保持跨语言统一图模型。缺点是每种语言仍需要维护自己的 AST 节点映射。推荐采用该方案。

### 方案 C：接入 TypeScript Compiler API、Pyright 或语言服务器

为每种语言接入完整编译器或 LSP，以获得类型、符号和精确引用。

优点是语义准确度最高。缺点是依赖体积、启动时间、项目配置、版本兼容和多语言维护成本明显增加，不符合当前 VS Code 插件的轻量本地索引目标。它可以作为后续可选语义增强层，而不是本阶段基础。

## 总体架构

```text
workspace source
  -> TreeSitterParserRuntime
       Parser.parse(text)
       Parser.delete() in runtime finally
  -> ParsedSource { text, tree?, diagnostics }
  -> LanguageAdapter
       tree exists   -> AST extractor
       tree missing  -> regex fallback extractor
  -> ExtractionResult
       nodes / edges / imports / unresolved references / diagnostics
  -> module path resolver
       ImportBinding.source -> resolvedFilePath
  -> reference resolver
       direct identifier / imported symbol / member call
  -> semantic graph
  -> Tree.delete() in workspace finally
```

Tree-sitter AST 是结构事实源，源码文本只用于读取节点文本和降级抽取。adapter 返回后不得保留 AST 节点引用，以便 workspace 立即释放 `Tree`。

## Parser Runtime 与生命周期

### 类型边界

`ParsedSource.tree` 不再使用无约束的 `unknown`。项目定义只包含当前所需能力的结构化接口：

```ts
export type SyntaxPoint = {
  row: number;
  column: number;
};

export type SyntaxNode = {
  type: string;
  text: string;
  isNamed: boolean;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
};

export type SyntaxTree = {
  rootNode: SyntaxNode;
  delete(): void;
};
```

`web-tree-sitter` 的 `Tree` 和 `Node` 在 runtime 边界适配为这些接口。这样 adapter 不依赖第三方库的完整 API，测试也可以构造最小语法树替身；真实集成测试仍必须加载 grammar WASM。

### 所有权

1. `TreeSitterParserRuntime.parse()` 创建 `Parser`，调用 `parse()` 后在 `finally` 中执行 `parser.delete()`。
2. 成功返回的 `Tree` 所有权转移给 `WorkspaceIntelligence`。
3. `WorkspaceIntelligence` 在 `adapter.extract(parsed)` 完成后，于 `finally` 中执行 `parsed.tree?.delete()`。
4. `ExtractionResult` 不允许保存 `SyntaxNode`、`SyntaxTree` 或 Tree-sitter cursor。
5. `Parser.parse()` 返回空值时记录 warning，并进入正则降级路径。

## AST 公共工具

新增 `languages/treeSitterAst.ts`，只提供两种语言都真实使用的能力：

- 深度优先遍历 named nodes。
- 将零基 `SyntaxPoint` 转为一基 `CodeNode` 行列范围。
- 按字段名安全读取子节点。
- 读取节点文本并去除字符串字面量引号。
- 查找最近的容器节点。

公共工具不包含 TypeScript、Python 或框架专用节点名称，语言语义仍留在对应 adapter。

## TypeScript 系 AST 抽取

TypeScript、TSX、JavaScript、JSX 继续共享一个 adapter，但 AST 主路径按 grammar 节点类型处理：

| 语法结构 | 输出 |
| --- | --- |
| `function_declaration`、generator function | `function` 节点 |
| 变量声明中的 `arrow_function`、`function_expression` | 使用变量名生成 `function` 节点 |
| `class_declaration` | `class` 节点 |
| `method_definition` | `method` 或 `constructor` 节点，`qualifiedName` 包含类名 |
| `interface_declaration` | `interface` 节点 |
| `type_alias_declaration` | `type` 节点 |
| `enum_declaration` | `enum` 节点 |
| `import_statement` | `ImportBinding`，支持 named/default/namespace/type-only 和多行形式 |
| `call_expression` | `UnresolvedReference` |
| `new_expression` | `instantiates` 引用 |

导出状态由祖先 `export_statement` 或声明修饰结构判断。函数、类和方法范围直接使用声明 AST 节点的完整范围。

调用表达式必须保留 callee 形态：

- `helper()`：`calleeKind = "identifier"`，允许进入导入、同文件和唯一名称解析。
- `service.helper()`：`calleeKind = "member"`，记录 `receiverName` 与 `memberName`，不按裸名称解析为同文件函数。
- `service[method]()`、可选链或其他动态形式：`calleeKind = "dynamic"`，保留元数据但不制造精确边。

## Python AST 抽取

Python adapter 的 AST 主路径处理：

| 语法结构 | 输出 |
| --- | --- |
| `function_definition`，包括 `async def` | 顶层 `function` 或类内 `method` |
| `class_definition` | `class` 节点 |
| `decorated_definition` | 使用内部声明范围，保留装饰器起始行元数据 |
| `import_from_statement` | named/alias/相对导入绑定 |
| `import_statement` | 模块导入绑定 |
| `call` | 裸名称、成员或动态调用引用 |

本阶段不索引局部嵌套函数为独立节点；嵌套函数中的调用也不错误归属到外层函数。所有函数和方法必须使用 AST 的完整结束位置。

## 导入路径解析

新增 `resolution/modulePathResolver.ts`，输入工作区文件路径集合和 `ImportBinding[]`，输出带 `resolvedFilePath` 的新绑定。

TypeScript 系相对导入按以下顺序匹配：

1. 精确文件路径。
2. `.ts`、`.tsx`、`.js`、`.jsx` 后缀。
3. `/index.ts`、`/index.tsx`、`/index.js`、`/index.jsx`。

Python 导入按工作区相对模块路径匹配 `.py` 和 `/__init__.py`。本阶段不读取 `tsconfig.paths`、虚拟环境、site-packages 或 bundler alias；无法解析时保留原始 `source`，不阻塞索引。

## 引用解析与置信度

`UnresolvedReference` 增加 callee 形态和建议置信度。引用解析规则为：

| 情况 | 处理 | 置信度 |
| --- | --- | --- |
| 已解析导入绑定且导出名唯一 | 连接目标节点 | `exact` |
| 同文件裸标识符且名称唯一 | 连接目标节点 | `probable` |
| 全工作区裸标识符且只有一个候选 | 连接目标节点 | `heuristic` |
| 成员调用且缺少接收者类型 | 保持未解析 | 不建边 |
| 动态调用 | 保持未解析 | 不建边 |

这样可以保留有用的调用线索，同时禁止把启发式名称匹配伪装成精确事实。

## 诊断与降级

1. Parser Runtime 只负责产生 parser/grammar/parse warning。
2. adapter 只产生语义抽取 warning，不再复制 `parsed.diagnostics`。
3. workspace 统一合并一次 `parsed.diagnostics` 与 `extracted.diagnostics`。
4. Tree-sitter 不可用时调用正则 fallback，并保留原始 parser warning。
5. AST 包含 `ERROR` 节点时仍抽取完整子树中的有效声明，同时记录一个文件级 warning，不因用户正在编辑而清空整文件索引。
6. 单个异常节点跳过并记录 warning，其他节点继续抽取。

## 性能约束

1. 每个变化文件只执行一次 AST 深度优先遍历，时间复杂度与 AST 节点数线性相关。
2. adapter 不缓存 `SyntaxNode`，避免 Tree 释放后留下失效引用。
3. 未变化文件继续复用 `ExtractionResult` 缓存，不重新创建 Parser 或 Tree。
4. 继续使用现有文件数量、文件大小、节点和边预算。
5. 本阶段不实现 `Tree.edit()` 和 old tree 增量解析；该能力只有在真实性能测试证明整文件重解析是瓶颈后再评估。

## 测试设计

### Parser Runtime

- 真实 TypeScript/Python grammar 返回可遍历的根节点。
- `Parser` 在成功和异常路径均释放。
- `Tree` 在 adapter 抽取成功和抛错路径均释放。
- parser 返回空 Tree 时产生 warning 并降级。

### TypeScript 系 adapter

- 真实 Tree 能抽取普通函数、generator、箭头函数、类、constructor、方法、interface、type 和 enum。
- 字符串、注释、模板字符串、对象字面量和 JSX 中的花括号不影响范围。
- named/default/namespace/type-only、多行导入正确产生绑定。
- `helper()` 产生 identifier 引用；`service.helper()` 产生 member 引用且不错误连到裸函数。
- 无 Tree 时原有简单正则样例继续工作。

### Python adapter

- 真实 Tree 能抽取 `def`、`async def`、装饰函数、类和方法完整范围。
- named、alias、模块和相对导入正确产生绑定。
- 成员调用不错误解析为裸函数。
- 无 Tree 时原有简单正则样例继续工作。

### 模块与引用解析

- TypeScript 相对文件和 `index` 模块解析。
- Python 模块和 package `__init__.py` 解析。
- 别名导入连接真实目标并标记 `exact`。
- 同文件裸调用标记 `probable`。
- 全局唯一名称 fallback 标记 `heuristic`。
- 成员调用不建错误边。

### 回归验证

- AST、workspace、上下文和 provider 注入相关测试全部通过。
- `npm run typecheck` 通过。
- `npm run compile` 通过并包含全部 Tree-sitter WASM 资产。
- 打包后的 Extension Development Host 中执行一次真实索引，确认无重复 warning，并记录连续重建时的内存变化。

## 实施顺序

1. 收紧 `ParsedSource.tree` 类型并建立 Parser/Tree 生命周期测试。
2. 新增共享 AST 工具。
3. 实现 TypeScript 系 AST 主路径，保留现有 fallback。
4. 实现 Python AST 主路径，保留现有 fallback。
5. 实现模块路径解析和引用置信度。
6. 修复诊断合并并执行完整回归验证。
7. AST 语义正确性验证通过后，再执行 SQLite chunk 与持久化计划。

## 关键取舍

1. Tree-sitter 提供语法事实，统一 `CodeNode`/`CodeEdge` 提供跨语言图模型。
2. 不为追求表面覆盖率制造错误精确边；成员和动态调用在缺少类型信息时宁可保持未解析。
3. 正则抽取保留为可观察的降级能力，不再作为正常主路径。
4. 第一版优先保证范围、符号、导入和直接调用正确，不提前实现完整编译器语义。
5. SQLite 只持久化经过 AST 验证的事实，避免后续向量检索放大错误关系。
