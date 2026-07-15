# 持久化符号源码片段实施计划

> **Agent 执行要求：** 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 在当前 checkout、当前分支逐步执行。步骤使用复选框（`- [ ]`）跟踪，并按 RED -> GREEN -> REFACTOR 完成。

**目标：** 让 SQLite symbol chunk 保存并返回最多 120 行的真实函数、方法或类源码，同时保持现有 FTS token、embedding 文本和数据库契约不变。

**架构：** `buildExtractionSnapshot` 把 `parsed.text` 作为 `fileText` 传给 `createCodeChunks`。chunker 按节点的一基闭区间截取正文并生成 `sourceHash`；无效范围回退现有元数据 card。`workspaceIndexer` 使用 chunker 版本 2 触发旧版本文件重建；现有 SQLite store、worker RPC 和 prompt renderer 原样消费更新后的 `sourceText`。

**技术栈：** TypeScript、Node.js 标准字符串 API、node:crypto、node:sqlite、Vitest。

**设计规格：** `docs/superpowers/specs/2026-07-15-persisted-symbol-source-design.md`

## 全局约束

- 不新增依赖、设置、命令、数据库 migration、列、表或 worker RPC。
- `file_card` 保持现有元数据摘要，不保存整文件正文。
- `symbol_card.searchText` 和 `embeddingText` 保持现有元数据内容；只有 `sourceText/sourceHash` 使用真实源码。
- 每个 symbol source 固定最多 120 行；prompt 继续执行最多 6 个命中和 6,000 字符总预算。
- 无效范围定义为 `startLine < 1`、`startLine` 超过文件末尾或 `endLine < startLine`，此时回退元数据 card。

---

## 任务 1：从 snapshot 写入并检索真实符号源码

**文件：**

- Modify: `src/extension/intelligence/indexing/extractionSnapshot.ts`
- Modify: `src/extension/intelligence/indexing/workspaceIndexer.ts`
- Modify: `src/extension/intelligence/chunking/codeChunker.ts`
- Modify: `test/intelligence/codeChunker.test.ts`
- Modify: `test/intelligence/sqliteCodeSearch.test.ts`
- Modify: `test/intelligence/workspaceIndexer.test.ts`
- Modify: `docs/superpowers/specs/2026-07-15-persisted-symbol-source-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-persisted-symbol-source-plan.md`

**接口：**

- 输入：`SnapshotInput.parsed.text` 与 `SnapshotNode.startLine/endLine`。
- 输出：`createCodeChunks` 的内部输入增加 `fileText: string`；公开的 `ExtractionSnapshot`、`CodeChunk`、SQLite schema 和 worker DTO 不变。
- 兼容：`CHUNKER_VERSION` 提升为 2，复用现有 `files.chunker_ver` 触发旧索引重建，不新增 schema migration。

- [x] **Step 1：写真实源码、hash、范围和语言 RED 测试**

调整 `test/intelligence/codeChunker.test.ts` 的 fixture，使源码实际位于节点声明的行范围。函数正文使用三行：

```ts
function snapshotInput(functionStartLine: number, body = "  consume(value);"): SnapshotInput {
  const lines = [
    ...Array.from({ length: functionStartLine - 1 }, () => ""),
    "export function createCodeCards(value: string): void {",
    body,
    "}",
    "function helper(): void {",
    "}",
  ];
  const file: CodeNode = {
    id: "file:sample", kind: "file", name: "sample.ts", qualifiedName: "src/sample.ts",
    filePath: "src/sample.ts", languageId: "typescript", startLine: 1, endLine: lines.length,
  };
  const run: CodeNode = {
    id: "run", kind: "function", name: "createCodeCards",
    qualifiedName: "src/sample.ts::createCodeCards", filePath: file.filePath,
    languageId: "typescript", startLine: functionStartLine, endLine: functionStartLine + 2,
    signature: "createCodeCards(value: string): void", isExported: true,
  };
  const helper: CodeNode = {
    id: "helper", kind: "function", name: "helper", qualifiedName: "src/sample.ts::helper",
    filePath: file.filePath, languageId: "typescript",
    startLine: functionStartLine + 3, endLine: functionStartLine + 4, signature: "helper(): void",
  };
  const contains = (target: string): CodeEdge => ({
    id: `contains:${target}`, source: file.id, target, kind: "contains",
    filePath: file.filePath, line: 1, confidence: "exact",
  });
  return {
    fileUri: "file:///workspace/src/sample.ts",
    filePath: file.filePath,
    parsed: { filePath: file.filePath, languageId: "typescript", text: lines.join("\n"), diagnostics: [] },
    extraction: {
      nodes: [file, run, helper], edges: [contains(run.id), contains(helper.id)],
      importBindings: [], unresolvedReferences: [], diagnostics: [],
    },
  };
}
```

在现有稳定性测试中增加：

```ts
const first = buildExtractionSnapshot(snapshotInput(5));
const moved = buildExtractionSnapshot(snapshotInput(25));
const changed = buildExtractionSnapshot(snapshotInput(5, "  consume(value.trim());"));
const symbol = (snapshot: typeof first) => snapshot.chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;

expect(symbol(first).sourceText).toBe([
  "export function createCodeCards(value: string): void {",
  "  consume(value);",
  "}",
].join("\n"));
expect(symbol(moved).sourceHash).toBe(symbol(first).sourceHash);
expect(symbol(changed).sourceHash).not.toBe(symbol(first).sourceHash);
expect(symbol(changed).searchHash).toBe(symbol(first).searchHash);
expect(symbol(changed).embeddingHash).toBe(symbol(first).embeddingHash);
```

增加以下完整 helper 和边界用例，覆盖 130 行 TypeScript function、两行 Python class 和超出文件末尾的 node：

```ts
function singleSymbolInput({
  filePath, languageId, text, startLine, endLine,
}: {
  filePath: string; languageId: string; text: string; startLine: number; endLine: number;
}): SnapshotInput {
  const lineCount = text.split(/\r?\n/).length;
  const file: CodeNode = {
    id: "file", kind: "file", name: filePath.split("/").at(-1)!, qualifiedName: filePath,
    filePath, languageId, startLine: 1, endLine: lineCount,
  };
  const symbol: CodeNode = {
    id: "symbol", kind: languageId === "python" ? "class" : "function", name: "Service",
    qualifiedName: `${filePath}::Service`, filePath, languageId, startLine, endLine,
  };
  return {
    fileUri: `file:///workspace/${filePath}`,
    filePath,
    parsed: { filePath, languageId, text, diagnostics: [] },
    extraction: {
      nodes: [file, symbol], edges: [], importBindings: [], unresolvedReferences: [], diagnostics: [],
    },
  };
}

it("clips symbol source and falls back for invalid ranges", () => {
  const longText = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join("\n");
  const longChunk = buildExtractionSnapshot(singleSymbolInput({
    filePath: "src/long.ts", languageId: "typescript", text: longText, startLine: 1, endLine: 130,
  })).chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;
  const pythonChunk = buildExtractionSnapshot(singleSymbolInput({
    filePath: "service.py", languageId: "python", text: "class Service:\n    pass", startLine: 1, endLine: 2,
  })).chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;
  const invalidChunk = buildExtractionSnapshot(singleSymbolInput({
    filePath: "src/invalid.ts", languageId: "typescript", text: "line 1\nline 2", startLine: 3, endLine: 4,
  })).chunks.find((chunk) => chunk.chunkKind === "symbol_card")!;

  expect(longChunk.sourceText.split("\n")).toHaveLength(120);
  expect(pythonChunk.sourceText).toBe("class Service:\n    pass");
  expect(invalidChunk.sourceText).toContain("qualified:");
});
```

在 `test/intelligence/sqliteCodeSearch.test.ts` 把 fixture 正文改为可区分的真实实现，并收紧断言：

```ts
text: 'export function createAgent() { return "ready"; }'

expect(store.searchCodeChunks("create Agent", 1)).toEqual([
  expect.objectContaining({
    filePath: "src/agent.ts",
    startLine: 1,
    sourceText: 'export function createAgent() { return "ready"; }',
  }),
]);
```

- [x] **Step 2：运行确认 RED**

运行：

```powershell
npm test -- test/intelligence/codeChunker.test.ts test/intelligence/sqliteCodeSearch.test.ts --reporter=dot
```

预期：FAIL。symbol `sourceText` 仍为 `name/qualified/kind/signature/exported/calls` card，不等于真实正文；SQLite 断言同样失败。

- [x] **Step 3：实现最小源码范围截取**

在 `codeChunker.ts` 的私有输入和 helper 中加入：

```ts
const MAX_SYMBOL_SOURCE_LINES = 120;

type CodeChunkInput = {
  file: SnapshotFile;
  fileText: string;
  nodes: readonly SnapshotNode[];
  importBindings: readonly SnapshotImportBinding[];
  unresolvedReferences: readonly SnapshotReference[];
  diagnostics: readonly SnapshotDiagnostic[];
};

function readSymbolSource(fileText: string, startLine: number, endLine: number): string | undefined {
  const lines = fileText.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length || endLine < startLine) return undefined;
  const startIndex = startLine - 1;
  return lines.slice(startIndex, Math.min(endLine, startIndex + MAX_SYMBOL_SOURCE_LINES, lines.length)).join("\n") || undefined;
}
```

在 symbol 循环中先构建现有元数据 card，再分别赋值：

```ts
const metadataText = [
  `name: ${node.name}`,
  `qualified: ${node.qualifiedName}`,
  `kind: ${node.kind}`,
  `signature: ${node.signature ?? ""}`,
  `exported: ${Boolean(node.isExported)}`,
  `calls: ${calls.join(", ")}`,
].join("\n");

sourceText: readSymbolSource(input.fileText, node.startLine, node.endLine) ?? metadataText,
embeddingText: metadataText,
```

在 `extractionSnapshot.ts` 复用现有 snapshot，不建立新对象层：

```ts
return {
  ...snapshot,
  chunks: createCodeChunks({ ...snapshot, fileText: input.parsed.text }),
};
```

- [x] **Step 4：运行 GREEN、集中验证并审查 diff**

运行：

```powershell
npm test -- test/intelligence/codeChunker.test.ts test/intelligence/sqliteCodeSearch.test.ts test/intelligence/sqliteSnapshotStore.test.ts test/intelligence/workspaceIndexer.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts --reporter=dot
npm test -- --reporter=dot
npm run typecheck
npm run compile
git diff --check
```

预期：全部通过。确认 diff 没有 schema、worker、prompt 或依赖变更；确认只有正文变化时 `sourceHash` 变化，纯行号移动不改 hash。

- [x] **Step 5：更新中文完成记录并提交**

把设计状态更新为“已实现”，在本计划末尾记录测试文件/用例数、类型检查、编译、diff 检查和实际限制，并勾选已完成步骤。

运行：

```powershell
git add src/extension/intelligence/indexing/extractionSnapshot.ts src/extension/intelligence/chunking/codeChunker.ts test/intelligence/codeChunker.test.ts test/intelligence/sqliteCodeSearch.test.ts docs/superpowers/specs/2026-07-15-persisted-symbol-source-design.md docs/superpowers/plans/2026-07-15-persisted-symbol-source-plan.md
git diff --cached --check
git commit -m "feat(intelligence): persist symbol source snippets"
```

预期：原功能提交只包含该步骤 `git add` 列出的 6 个文件；审查修复另行提交，不自动推送。

## 审查修复：chunker 版本触发重建

- [x] **Step 6：增加旧版本索引 RED 测试**

在 `test/intelligence/workspaceIndexer.test.ts` 使用真实 SQLite store 建立索引，将 `files.chunker_ver` 设回 1，并在 mtime 和字节数不变时重启 indexer。当前版本 1 不会调用 parser，测试按预期失败。

- [x] **Step 7：提升 chunker 版本并确认 GREEN**

把 `src/extension/intelligence/indexing/workspaceIndexer.ts` 的 `CHUNKER_VERSION` 提升为 2。启动扫描将旧版本文件入队，处理阶段重新解析并把版本写回 2；不修改数据库 schema。

- [x] **Step 8：运行审查修复门禁并独立提交**

运行 workspaceIndexer、codeChunker 和 SQLite code search 覆盖测试，以及类型检查和 diff 检查。修复使用独立 commit，不改写原功能提交，不推送。

## 实施记录（2026-07-15）

- RED：`npm test -- test/intelligence/codeChunker.test.ts test/intelligence/sqliteCodeSearch.test.ts --reporter=dot` 按预期失败，2 个测试文件、3 个用例均显示 symbol `sourceText` 仍为元数据 card。
- GREEN：同一命令通过，2 个测试文件、3 个用例全部通过。
- 受影响测试：计划列出的 5 个测试文件、19 个用例全部通过。
- 全量测试：50 个测试文件、267 个用例全部通过。
- `npm run typecheck`、`npm run compile`、`git diff --check` 均通过。
- 实际限制与设计一致：symbol 正文最多 120 行；无效或空范围回退元数据 card；`file_card`、FTS token、embedding 文本、数据库契约和 prompt 预算保持不变。
- 审查修复 RED：`workspaceIndexer.test.ts` 1 个用例失败、1 个通过；新用例中 parser 期望调用 1 次、实际 0 次。
- 审查修复 GREEN：同文件 2 个用例全部通过；覆盖测试共 3 个测试文件、5 个用例全部通过，`npm run typecheck` 和 `git diff --check` 通过。
- 兼容结果：已有 `chunker_ver=1` 的文件在文件元数据不变时会重新解析并写回版本 2；复用现有字段，不需要 schema migration。
