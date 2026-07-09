# 增量代码索引与 Tree-sitter Runtime 实施计划

Plan REQUIRED SUB-SKILL: superpowers:subagent-driven-development superpowers:executing-plans task-by-task.

**Goal:** 把现有 VS Code 工作区代码上下文升级为增量缓存索引，并接入 Tree-sitter runtime 作为真实 AST 解析基础。

**Architecture:** `vscodeWorkspaceIntelligence` 负责 VS Code 文件发现、读取缓存和 watcher 脏标记；`workspaceIntelligence` 负责抽取缓存、图重组和 prompt 构建；`treeSitterRuntime` 负责加载 parser/grammar wasm 并产出 `ParsedSource.tree`。

**Tech Stack:** TypeScript、VS Code extension API 适配层、Vitest、`web-tree-sitter`、`@vscode/tree-sitter-wasm`、esbuild。

---

## 任务 1：增加 Tree-sitter 依赖与 wasm 复制

### 步骤 1：修改依赖

修改 `package.json`：

```json
{
  "dependencies": {
    "@vscode/tree-sitter-wasm": "^0.3.1",
    "web-tree-sitter": "^0.26.10"
  }
}
```

运行：

```powershell
npm install
```

预期：`package-lock.json` 更新，`node_modules` 安装成功。

### 步骤 2：写构建资产测试

新增 `test/treeSitterAssets.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { TREE_SITTER_ASSETS } from "../esbuild";

describe("TREE_SITTER_ASSETS", () => {
  it("lists parser runtime and first-stage language wasm files", () => {
    expect(TREE_SITTER_ASSETS.map((asset) => asset.outputName)).toEqual([
      "web-tree-sitter.wasm",
      "tree-sitter-typescript.wasm",
      "tree-sitter-tsx.wasm",
      "tree-sitter-javascript.wasm",
      "tree-sitter-python.wasm",
    ]);
  });
});
```

运行：

```powershell
npm test -- test/treeSitterAssets.test.ts
```

预期：FAIL，`esbuild` 未导出 `TREE_SITTER_ASSETS`。

### 步骤 3：实现资产列表与复制

修改 `esbuild.js`：

- 导出 `TREE_SITTER_ASSETS`。
- 新增 `copyTreeSitterAssets()`。
- `build()` 在 `esbuild.build(...)` 之后执行复制。
- `watch()` 在启动 watch 前先复制一次。

### 步骤 4：验证并提交

运行：

```powershell
npm test -- test/treeSitterAssets.test.ts
npm run compile
```

预期：PASS，`dist/tree-sitter/` 包含 5 个 wasm 文件。

提交：

```powershell
git add package.json package-lock.json esbuild.js test/treeSitterAssets.test.ts
git commit -m "feat(intelligence): package tree-sitter wasm assets"
```

---

## 任务 2：实现 Tree-sitter ParserRuntime

### 步骤 1：写失败测试

新增 `test/intelligence/treeSitterRuntime.test.ts`：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTreeSitterParserRuntime } from "../../src/extension/intelligence/parser/treeSitterRuntime";

const wasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

describe("createTreeSitterParserRuntime", () => {
  it("parses TypeScript with a real tree", async () => {
    const runtime = createTreeSitterParserRuntime({ wasmDirectory });
    const parsed = await runtime.parse("src/a.ts", "typescript", "export function run() { return 1; }");
    expect(parsed.tree).toBeTruthy();
    expect(parsed.diagnostics).toEqual([]);
  });

  it("degrades unsupported languages without throwing", async () => {
    const runtime = createTreeSitterParserRuntime({ wasmDirectory });
    const parsed = await runtime.parse("README.md", "markdown", "# title");
    expect(parsed.tree).toBeUndefined();
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ severity: "warning" })]);
  });
});
```

运行：

```powershell
npm test -- test/intelligence/treeSitterRuntime.test.ts
```

预期：FAIL，缺少 `treeSitterRuntime`。

### 步骤 2：实现 runtime

新增 `src/extension/intelligence/parser/treeSitterRuntime.ts`：

- 使用 `web-tree-sitter` 初始化 parser runtime。
- 按 `languageId` 映射 wasm：
  - `typescript` -> `tree-sitter-typescript.wasm`
  - `typescriptreact` -> `tree-sitter-tsx.wasm`
  - `javascript` -> `tree-sitter-javascript.wasm`
  - `javascriptreact` -> `tree-sitter-javascript.wasm`
  - `python` -> `tree-sitter-python.wasm`
- 解析失败返回 diagnostic，不抛出到模型链路。

### 步骤 3：验证并提交

运行：

```powershell
npm test -- test/intelligence/treeSitterRuntime.test.ts
npm run typecheck
```

提交：

```powershell
git add src/extension/intelligence/parser/treeSitterRuntime.ts test/intelligence/treeSitterRuntime.test.ts
git commit -m "feat(intelligence): add tree-sitter parser runtime"
```

---

## 任务 3：让 WorkspaceIntelligence 使用 parser runtime 和抽取缓存

### 步骤 1：写失败测试

修改 `test/intelligence/workspaceIntelligence.test.ts`，新增测试：

```ts
it("reuses cached extraction when file content is unchanged", async () => {
  let parseCalls = 0;
  const intelligence = createWorkspaceIntelligence({
    parserRuntime: {
      async parse(filePath, languageId, text) {
        parseCalls += 1;
        return { filePath, languageId, text, tree: { ok: true }, diagnostics: [] };
      },
    },
    readWorkspaceFiles: async () => [
      { path: "src/a.ts", languageId: "typescript", text: "function run() {}" },
    ],
    readSourceRange: () => "function run() {}",
  });

  await intelligence.buildCodeIntelligencePrompt("run");
  await intelligence.buildCodeIntelligencePrompt("run");

  expect(parseCalls).toBe(1);
});
```

运行：

```powershell
npm test -- test/intelligence/workspaceIntelligence.test.ts
```

预期：FAIL，当前每次请求都会重新解析。

### 步骤 2：实现缓存

修改 `src/extension/intelligence/workspaceIntelligence.ts`：

- `WorkspaceIntelligenceDeps` 增加 `parserRuntime?: ParserRuntime`。
- 维护 `extractionCacheByFile`。
- 缓存 key 使用 `file.path` 和 `contentHash`。
- 未变化文件复用 `ExtractionResult`。
- 文件变化时重新 `parserRuntime.parse(...)`，再调用 adapter。
- parser runtime 不存在时保持现有 behavior。

### 步骤 3：验证并提交

运行：

```powershell
npm test -- test/intelligence/workspaceIntelligence.test.ts
npm run typecheck
```

提交：

```powershell
git add src/extension/intelligence/workspaceIntelligence.ts test/intelligence/workspaceIntelligence.test.ts
git commit -m "feat(intelligence): cache workspace extraction results"
```

---

## 任务 4：接入 VS Code watcher 增量读取

### 步骤 1：写失败测试

修改 `test/intelligence/vscodeWorkspaceIntelligence.test.ts`，新增 fake watcher 测试：

```ts
it("reuses cached source until a watcher change marks the file dirty", async () => {
  const watcher = createFakeWatcher();
  let readCount = 0;
  const api = createFakeVsCodeApi({
    watcher,
    files: new Map([["/repo/src/a.ts", "function run() {}"]]),
    onRead: () => { readCount += 1; },
  });

  const intelligence = createVsCodeWorkspaceIntelligence(api);
  await intelligence.buildCodeIntelligencePrompt("run");
  await intelligence.buildCodeIntelligencePrompt("run");
  expect(readCount).toBe(1);

  watcher.fireChange({ fsPath: "/repo/src/a.ts" });
  await intelligence.buildCodeIntelligencePrompt("run");
  expect(readCount).toBe(2);
});
```

运行：

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts
```

预期：FAIL，当前没有 watcher 脏标记。

### 步骤 2：实现 watcher

修改 `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`：

- `VsCodeWorkspaceApi.workspace` 增加可选 `createFileSystemWatcher(pattern)`。
- 新增 watcher 类型接口，支持 `onDidCreate`、`onDidChange`、`onDidDelete`、`dispose`。
- `createVsCodeWorkspaceIntelligence` 创建 watcher，change/create 加入 `dirtyPaths`，delete 移除缓存。
- `readWorkspaceFiles` 未 dirty 且 sourceCache 命中时不再调用 `workspace.fs.readFile`。

### 步骤 3：验证并提交

运行：

```powershell
npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
npm run typecheck
```

提交：

```powershell
git add src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts test/providerRegistryCodeContext.test.ts
git commit -m "feat(intelligence): incrementally refresh VS Code workspace sources"
```

---

## 任务 5：把 Tree-sitter runtime 接到 VS Code workspace intelligence

### 步骤 1：写失败测试

修改 `test/providerRegistryCodeContext.test.ts`：

- mock `createTreeSitterParserRuntime`，确认 deepseek provider 路径会创建 parser runtime。
- 保留 fake `WorkspaceIntelligence` 注入场景，避免测试真实 wasm。

运行：

```powershell
npm test -- test/providerRegistryCodeContext.test.ts
```

预期：FAIL，`providerRegistry` 没有向 `createVsCodeWorkspaceIntelligence` 传入 parser runtime。

### 步骤 2：实现接入

修改：

- `src/extension/model/providerRegistry.ts`
- `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`

行为：

```text
providerRegistry
  -> createTreeSitterParserRuntime()
  -> createVsCodeWorkspaceIntelligence(vscodeApi, { parserRuntime })
```

如果 runtime 初始化失败或 wasm 缺失，`treeSitterRuntime` 自身降级，模型链路不失败。

### 步骤 3：验证并提交

运行：

```powershell
npm test -- test/providerRegistryCodeContext.test.ts test/intelligence/treeSitterRuntime.test.ts
npm run typecheck
```

提交：

```powershell
git add src/extension/model/providerRegistry.ts src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/providerRegistryCodeContext.test.ts
git commit -m "feat(model): use tree-sitter parser runtime for workspace context"
```

---

## 任务 6：更新文档与最终验证

### 步骤 1：写验证记录

新增 `docs/superpowers/plans/2026-07-09-incremental-index-tree-sitter-verification.md`：

````md
# 增量代码索引与 Tree-sitter Runtime 验证记录

## 验证命令

```powershell
npm test
npm run typecheck
npm run compile
```

## 结果

- `npm test`：记录通过的测试文件数和用例数。
- `npm run typecheck`：通过。
- `npm run compile`：通过，并确认 `dist/tree-sitter/` 包含 wasm 资产。
````

### 步骤 2：更新设计文档实施状态

修改 `docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md`，追加：

```md
## 实施记录

本轮已经完成抽取缓存、VS Code watcher 脏文件刷新、Tree-sitter runtime、wasm 构建资产复制和模型链路接入。
```

### 步骤 3：最终验证

运行：

```powershell
npm test
npm run typecheck
npm run compile
git status --short --branch
```

提交：

```powershell
git add docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md docs/superpowers/plans/2026-07-09-incremental-index-tree-sitter-verification.md
git commit -m "docs: verify incremental tree-sitter code intelligence"
```

## 完成标准

- `npm test`、`npm run typecheck`、`npm run compile` 均通过。
- `dist/tree-sitter/` 有 runtime 和四类语言 grammar wasm。
- 同一文件未变化时，重复 query 不重复 parse/extract。
- VS Code watcher change 后会重读脏文件。
- 删除文件不会继续出现在 prompt 中。
- Tree-sitter parse 成功时 `ParsedSource.tree` 非空。
- Tree-sitter 不支持语言或失败时模型链路继续返回 prompt。
