# 稳定 Chunk 与 Snapshot 最小设计

> 状态：最小 card snapshot 已实现，等待工作区增量接入。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-11-sqlite-index-chunk-snapshot-plan.md`
>
> 前置规格：`docs/superpowers/specs/2026-07-11-sqlite-index-storage-worker-design.md`

## 目标

将一次文件 AST 抽取转换为稳定、可序列化的 snapshot，先持久化最小的文件和符号 card，并通过 SQLite FTS 查询。行号移动不能改变 card ID、搜索文本或 embedding 文本。

## 本轮范围

1. 保持已完成的稳定文件、节点、边和关系身份。
2. 为每个文件生成一个 `file_card`，为每个非 file snapshot node 生成一个 `symbol_card`。
3. 复用内存 `SearchIndex` 的标识符和路径拆词规则生成确定性 `searchText`。
4. 计算 `sourceHash`、`searchHash`、`embeddingHash`。
5. 在 writer lease 保护的单文件事务中替换陈旧事实和 card，并只在 `searchHash` 改变时写 FTS。

本轮不生成 class、test、callsite 或 source-body card；不进行 AST 子块切分；不建立独立 diff API；不创建 embedding mapping 或执行远程 embedding。

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

snapshot 只保存结构化数据，不能保存 Tree-sitter tree、parser、函数或 VS Code 对象。tree 的释放责任始终由调用方承担。

## 稳定身份

文件 ID 使用规范化 workspace-relative path：统一 `/`、折叠重复分隔符、`.` 和 `..`，移除前导 `./`，保持真实大小写。URI 仅保存为 metadata，不参与主身份。

节点 ID 使用文件 ID 与语义键的 UTF-8 SHA-256。语义键包括 kind、规范化 qualified name、规范化 signature、declaration/concrete role 和父容器最终语义键；不包含 range、mtime 或时间。重复节点、边、binding、reference 和 diagnostic 保持按抽取顺序的 occurrence ordinal，以满足主键唯一且保持整体行移稳定。

chunk ID 使用文件 ID、chunk kind 与 chunk semantic key 的 UTF-8 SHA-256：

```ts
export function createStableChunkId(
  fileId: string,
  kind: CodeChunkKind,
  semanticKey: string,
): string;
```

## Chunk 契约

```ts
type CodeChunkKind = "file_card" | "symbol_card";

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
};
```

`file_card` 包含相对路径、语言、导出符号摘要、主要 import、顶层声明和文件级诊断摘要，不包含整文件源码。

`symbol_card` 包含名称、qualified name、kind、signature、导出状态、容器和关联 import/call 摘要，不包含完整函数体。类和接口先作为 `symbol_card`，不额外生成聚合 card。

## 搜索文本与 Hash

`chunking/searchText.ts` 提供共享的 `createSearchTokens(value)`。它覆盖 camelCase、snake_case、kebab-case、qualified name 与路径拆词；`SearchIndex` 和 card 均调用它，避免两套检索语义。

三个 hash 均为 UTF-8 SHA-256：

1. `sourceHash` 对应可显示 card 内容。
2. `searchHash` 对应 FTS 文本。
3. `embeddingHash` 对应未来 embedding 输入，排除 range 等波动 metadata。

范围单独保存；仅插入空行时三个 hash 不变。

## 单文件事务

`applyFileSnapshot(ownerId, snapshot): void` 先验证 writer lease，并在同一 SQLite transaction 中：

1. 读取该 file 已持久化的 card 和事实 ID。
2. 删除 incoming snapshot 中不存在的 chunk、edge、binding、reference 和 diagnostic。
3. upsert incoming node、关系和 chunk。
4. 三个 hash 未变的 card 只更新 range 并保留原 `updated_at`；对新 card 或 `searchHash` 改变的 card 重写对应 FTS 行。
5. 更新 file hash、版本、indexed_at 和 ready 状态后提交。

不创建 `SnapshotChangeSet` 或七类 enum。对每个 card 的直接 hash 比较足以决定是否更新 chunk、FTS 或未来 embedding。任何 SQL 或约束错误回滚整个文件，旧 snapshot 保持可读。

## 验证

1. 行号移动后 node、edge、file/symbol card ID 不变，范围正确更新。
2. overload 和重复声明保持唯一稳定身份。
3. file/symbol card 的内容、搜索拆词和三层 hash 确定。
4. 两函数文件仅移动范围时，FTS 行和 card `updated_at` 不变。
5. 删除符号后不残留 edge、chunk 或 FTS 行。
6. 外键错误使整个文件事务回滚，旧 snapshot 完整保留。
7. 已有 `SearchIndex` 测试继续验证同一拆词语义。

## 后续触发条件

- 真实代码问答缺少函数体时，增加 `source_body`；首版使用固定文本上限切分。
- language adapter 输出测试、继承或调用点事实，且评估显示符号卡不足时，增加对应 card。
- 需要第二个持久化后端或实测大量无效写入时，再抽取 diff API。
- embedding provider/model 与批处理器存在后，再写 `chunk_embeddings` 的 pending、retry 与 cache 生命周期。

## 完成门禁

本规格完成后，调用方可以把单个变化文件转换为稳定的最小 card snapshot、事务写入 SQLite 并通过 FTS 查询。工作区发现、watcher、跨文件重解析、复杂源码切分和远程 embedding 继续由后续独立计划承担。
