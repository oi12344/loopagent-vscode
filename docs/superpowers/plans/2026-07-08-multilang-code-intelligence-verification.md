# 多语言代码智能索引验证记录

## 验证范围

- 内存语义图与名称搜索索引。
- TS/JS 与 Python 基础符号抽取。
- 未解析引用到语义边的解析。
- 一跳图遍历、`exploreCode` 上下文构建和 prompt 渲染。
- `WorkspaceIntelligence` 编排、内存预算保护和空实现注入点。
- `modelRunner` 的 `systemPromptProvider(request)` 签名调整。
- VS Code workspace 路径过滤基础。

## 验证命令

```powershell
npm test
npm run typecheck
npm run compile
```

## 结果

- `npm test`：通过，`21` 个测试文件、`61` 个测试用例 passed。
- `npm run typecheck`：通过，`tsc --noEmit -p ./` 退出码为 `0`。
- `npm run compile`：通过，`node esbuild.js` 退出码为 `0`。

## 产物说明

- `npm run compile` 生成 `dist/extension.js`、`dist/webview.js` 及对应 sourcemap/css 产物。
- 当前仓库没有跟踪 `dist/` 文件，编译后 `git status --short` 仍为空。

## 已知限制

- 当前 adapter 只覆盖基础语法形态，尚未接入真实 Tree-sitter runtime。
- 第一阶段没有实现框架专用补边，例如 React render、NestJS route、Spring controller 等。
- VS Code workspace 文件读取本轮只落路径过滤基础，真实扫描和增量更新需要后续任务接入。
- 语义图仍为内存索引，尚未接入 SQLite 持久化。
