# 稳定 Chunk 与 Snapshot 差异设计

> 状态：设计和实施计划已批准，等待执行。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-11-sqlite-index-chunk-snapshot-plan.md`
>
> 前置规格：`docs/superpowers/specs/2026-07-11-sqlite-index-storage-worker-design.md`

## 目标

把一次文件 AST 抽取转换为稳定、可序列化的 `ExtractionSnapshot`，并在 SQLite 事务内只修改真正变化的节点、关系、chunk、FTS 和 embedding 映射。

## 范围

1. 稳定文件、节点、边和 chunk 身份。
2. 生成 file、symbol、class、callsite、test 和 source body chunk。
3. 计算 `source_hash`、`search_hash`、`embedding_hash`。
4. 将新旧 snapshot 分类为七种差异。
5. 在单文件事务内应用精确写入集合并保证回滚一致性。

本规格不负责工作区扫描、watcher、跨文件调度、检索排序或远程 embedding 请求。

## 输入与输出

输入：

```ts
type SnapshotInput = {
  fileUri: string;
  filePath: string;
  parsed: ParsedSource;
  extraction: ExtractionResult;
};
```

输出：

```ts
type ExtractionSnapshot = {
  file: SnapshotFile;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  chunks: CodeChunk[];
  importBindings: SnapshotImportBinding[];
  unresolvedReferences: SnapshotReference[];
  diagnostics: SnapshotDiagnostic[];
};
```

snapshot 只能包含可结构化克隆的数据，不能保存 Tree-sitter tree、parser、函数或 VS Code 对象。

## 稳定身份

- 文件：规范化 workspace-relative path。规范化统一使用 `/` 分隔符，折叠重复分隔符、`.` 和 `..`，去除前导 `./`，但保持大小写。`SnapshotInput.filePath` 和 `resolvedFilePath` 必须来自同一次 canonical workspace 枚举并保留文件系统返回的真实 casing，不根据 `process.platform` 强制转小写。`SnapshotFile.uri` 仍保存调用方提供的原始 URI，URI 不参与主身份计算。
- 顶层符号：`kind + qualified_name + normalized_signature`。
- 类成员：父类语义键 + 成员 kind + 名称 + normalized signature。
- 文件卡片：固定语义键 `file_card`。
- 测试卡片：父级 describe 路径 + 测试 API 类型 + 测试名称。
- 超大函数子块：父符号键 + AST node type + 规范化首语句 hash；ordinal 只解决同键冲突。

所有 ID 使用 SHA-256 十六进制摘要：

```ts
createFileId(workspaceRelativePath: string): string;
createSymbolSemanticKey(node: CodeNode, parentKey?: string): string;
createStableNodeId(fileId: string, semanticKey: string): string;
createStableChunkId(fileId: string, chunkKind: CodeChunkKind, semanticKey: string): string;
```

ID 不包含行号、mtime 或索引时间。文件选择 path 身份域，是因为当前文件和已解析 import 目标都具备 workspace-relative `filePath`，而目标 URI 不一定可得；两者必须使用同一输入规则生成可连接的 file ID。符号语义键中的 qualified name path 前缀执行相同规范化。符号重命名视为删除旧身份并新增新身份。TypeScript function、method、constructor 和 arrow function 的稳定身份签名只由 type parameters、parameters 和 return type 等语法字段组成，不包含 body 或 range；真实 overload 必须由规范化签名区分。无 body 的 overload declaration 标记 `metadata.declarationOnly`；引用解析优先选择 concrete implementation，仅在没有实现时回退到 declaration。

同一文件内 edge、binding、unresolved reference 或 diagnostic 出现相同语义 tuple 时，按抽取输入的稳定顺序分配从 0 开始的 occurrence ordinal，并把 ordinal 纳入关系 ID hash。ordinal 不包含行号，因此整体行移不改变对应关系 ID；同时每条关系仍有唯一 ID，满足 `edges`、`import_bindings`、`unresolved_references` 和 `diagnostics` 表的 `id TEXT PRIMARY KEY` 契约。

## Chunk 数据契约

```ts
type CodeChunkKind =
  | "file_card"
  | "symbol_card"
  | "class_card"
  | "callsite_card"
  | "test_case_card"
  | "source_body";

type CodeChunk = {
  id: string;
  fileId: string;
  nodeId?: string;
  semanticKey: string;
  chunkKind: CodeChunkKind;
  sourceText: string;
  searchText: string;
  embeddingText: string;
  sourceHash: string;
  searchHash: string;
  embeddingHash: string;
  startLine?: number;
  endLine?: number;
  tokenHint: number;
};
```

card 字段顺序固定，所有 hash 使用 UTF-8 SHA-256。

## Chunk 规则

### `file_card`

每个文件固定一个，包含相对路径、语言、导出符号摘要、主要 import、顶层声明和文件级诊断摘要。不保存整文件源码。

### `symbol_card`

每个函数、方法、类、接口、type、enum、变量或 Python 定义一个，包含名称、qualified name、kind、签名、导出状态、所属容器、import/call 摘要和文档注释摘要。

### `class_card`

聚合类或接口的继承、实现、constructor、字段和方法签名，不重复方法体。

### `callsite_card`

只根据通用 AST 模式生成，例如 factory、registration、provider/client/runner/config 组合调用和顶层对象配置中的函数引用。不得加入项目业务词表。

### `test_case_card`

识别 `describe`、`it`、`test` 及 Python 测试函数，记录 describe 路径、测试名、被测调用和 fixture/import 摘要。

### `source_body`

1. 不超过 120 行且不超过 4,000 字符的函数或方法整体形成一个 chunk。
2. 超大函数优先按 `if`、`for`、`while`、`try`、`switch`、callback、object literal 的 named AST range 切分。
3. 子块目标 1,500-3,000 字符，硬上限 5,000 字符。
4. overlap 前后最多 8 行，只进入 `sourceText`，不进入 `embeddingText`。
5. 每个子块携带父函数签名、qualified name 和源码范围。

切块必须在 `parsed.tree?.delete()` 前完成；snapshot builder 不接管 tree 的释放责任。

## 搜索文本

`searchText` 复用现有 `searchIndex.ts` 的 camelCase、snake_case、kebab-case、qualified name 和路径拆词语义，输出确定性 token 字符串。迁移完成后纯拆词逻辑归 `chunking/searchText.ts`，旧完整内存 SearchIndex 不再保留。

## 三层 Hash

1. `source_hash`：准确的 `sourceText`，决定 prompt 内容是否更新。
2. `search_hash`：确定性的 `searchText`，决定是否重写 FTS。
3. `embedding_hash`：排除范围、时间等波动信息的 `embeddingText`，决定是否重新生成 embedding。

范围单独保存。仅在文件前插入空行时，三个 hash 都不变化。

## 七类差异

按 `embedding_hash -> search_hash -> source_hash -> metadata` 的优先级分类：

- `unchanged`：三个 hash 和范围元数据相同，不写入。
- `metadata-only`：三个 hash 相同，只更新范围或非检索元数据。
- `source-changed`：只更新 chunk 源码、source hash 和范围；不写 FTS，不改变 embedding 映射。
- `search-changed`：更新 chunk，并只在 search hash 变化时重写 FTS；embedding 继续复用。
- `embedding-changed`：更新 chunk，把当前 provider/model 映射标记为 `pending`；FTS 是否重写仍由 search hash 决定。
- `added`：插入完整事实、chunk、FTS 和待处理 embedding 映射。
- `removed`：删除所属节点、出边、引用、诊断、chunk、FTS 和映射；内容寻址 cache 延迟回收。

`SnapshotChangeSet` 分别列出 node、edge、binding、reference、diagnostic、chunk、FTS 和 embedding 操作，数组按稳定 ID 排序。分类名称不能替代精确写入集合。

## 关系所有权

边、binding、reference 和诊断尽可能记录 `owner_chunk_id`。当稳定 chunk 仍存在但出边消失时，事务必须删除旧出边；不能只 upsert 新边。跨文件入边由工作区增量规格使用持久化证据重新解析。

## 单文件事务

`applyFileSnapshot` 在一个 SQLite transaction 中按以下顺序执行：

1. 读取旧文件 snapshot。
2. 计算确定性的 `SnapshotChangeSet`。
3. 删除 removed chunk 的 FTS 和所属事实。
4. 删除变化 owner 的陈旧出边、binding、reference 和诊断。
5. upsert nodes、bindings、references、diagnostics 和 edges。
6. 按精确集合更新 chunk；只对 search hash 变化的 chunk 重写 FTS。
7. 只对 embedding hash 变化的映射设置 `pending`。
8. 更新 file hash、mtime、版本、indexed_at 和 `ready` 状态。
9. 提交；任一步失败自动 rollback。

worker 返回计数，不返回完整持久化 snapshot：

```ts
type SnapshotWriteStats = {
  inserted: number;
  updated: number;
  removed: number;
  ftsWrites: number;
  embeddingsInvalidated: number;
};
```

## 失败处理

- AST 抽取失败：不调用 snapshot 写入，保留数据库上一版。
- snapshot 构建失败：释放 tree，job 由上层标记失败。
- 约束或 SQL 错误：回滚整个文件事务，查询仍看到旧版本。
- 不可识别的 diff 状态：拒绝写入，不做全量覆盖 fallback。

## 验证

1. 行号移动后 node、edge、chunk ID 保持稳定，范围正确变化。
2. overload 由 normalized signature 区分。
3. 六种 chunk 的内容、ID、搜索拆词和三层 hash 符合规则。
4. 超大函数只在 named AST 边界切分，硬上限和 tree 单次释放得到验证。
5. 七类 diff 分别产生精确 chunk、FTS、embedding 操作。
6. 两函数文件只改第二个函数时，第一个 chunk 的 `updated_at` 和 embedding 映射不变。
7. 陈旧出边和 FTS 行被删除，不存在孤立记录。
8. 注入外键错误后整个文件事务回滚，旧 snapshot 完整保留。

## 完成门禁

本规格完成后，调用方可以把单个变化文件转换为稳定 snapshot 并安全持久化；它仍不负责发现文件变化或安排跨文件重解析。
