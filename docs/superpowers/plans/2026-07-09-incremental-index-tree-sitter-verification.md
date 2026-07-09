# 增量代码索引与 Tree-sitter Runtime 验证记录

## 验证范围

本记录覆盖 2026-07-09 增量代码索引与 Tree-sitter runtime 实现：

1. Tree-sitter wasm 资产复制到 `dist/tree-sitter/`。
2. TypeScript、TSX、JavaScript、JSX、Python 的 Tree-sitter runtime 接入。
3. `WorkspaceIntelligence` 抽取结果缓存。
4. VS Code workspace 源码缓存、watcher 脏标记和删除驱逐。
5. `providerRegistry` 模型链路接入 parser runtime。
6. `LoopAgentChatViewProvider` 连续 chat run 复用同一个 workspace intelligence 实例。

## 验证命令

```powershell
npm test
npm run typecheck
npm run compile
Get-ChildItem dist/tree-sitter | Select-Object -ExpandProperty Name
git status --short --branch
```

## 验收点

1. 全量 Vitest 通过。
2. TypeScript 类型检查通过。
3. `npm run compile` 通过，并复制 5 个 wasm 文件。
4. 重复查询未变化文件时不重复 parse/extract。
5. watcher change 后重读脏文件。
6. watcher delete 后 prompt 不再包含删除文件。
7. Tree-sitter 不支持语言或运行失败时降级为 warning diagnostic，不中断模型链路。
8. 侧边栏连续 chat run 复用同一个 workspace intelligence 实例。

## 结果

2026-07-09 在 `code-intel-incremental-treesitter` worktree 验证通过：

1. `npm test`：26 个测试文件通过，77 个用例通过。
2. `npm run typecheck`：通过，`tsc --noEmit -p ./` 退出码为 0。
3. `npm run compile`：通过，`node esbuild.js` 退出码为 0。
4. `dist/tree-sitter/` 包含以下 wasm 文件：
   - `web-tree-sitter.wasm`
   - `tree-sitter-typescript.wasm`
   - `tree-sitter-tsx.wasm`
   - `tree-sitter-javascript.wasm`
   - `tree-sitter-python.wasm`

本轮新增或更新的关键测试：

1. `test/treeSitterAssets.test.ts`
2. `test/intelligence/treeSitterRuntime.test.ts`
3. `test/intelligence/workspaceIntelligence.test.ts`
4. `test/intelligence/vscodeWorkspaceIntelligence.test.ts`
5. `test/providerRegistryCodeContext.test.ts`
6. `test/extensionWorkspaceIntelligence.test.ts`
