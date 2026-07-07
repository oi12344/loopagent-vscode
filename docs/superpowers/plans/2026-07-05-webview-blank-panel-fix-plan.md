# Webview 空白面板修复记录

## 问题

用户反馈运行 `LoopAgent: Open Panel` 后界面为空白。

用户提供的 VS Code Developer Tools 截图中，关键错误为：

```text
Uncaught Error: An instance of the VS Code API has already been acquired
```

同时控制台还出现 source map 相关 CSP 报错。

## 根因

`src/webview/App.tsx` 使用默认参数调用 `createDefaultVsCodeApi()`。

在 React 开发环境中，`React.StrictMode` 会触发重复渲染。默认参数会在每次渲染时重新求值，导致 `createDefaultVsCodeApi()` 多次调用 `acquireVsCodeApi()`。

VS Code Webview 规定 `acquireVsCodeApi()` 一个 Webview 生命周期只能调用一次。第二次调用会抛出异常，React 组件因此崩溃，面板表现为空白。

## 修复点

### 1. 缓存 VS Code API

更新 `src/webview/vscodeApi.ts`：

- `createDefaultVsCodeApi()` 缓存第一次获取到的 VS Code API。
- 后续调用直接返回缓存对象。
- 新增 `resetDefaultVsCodeApiForTests()` 仅用于测试隔离。

新增回归测试：

- `test/vscodeApi.test.ts`

测试目标：

- 连续调用 `createDefaultVsCodeApi()` 两次时，真实 `acquireVsCodeApi()` 只调用一次。

### 2. Webview HTML 可测试化

新增 `src/extension/webviewHtml.ts`，把 Webview HTML 生成逻辑从 `src/extension.ts` 中拆出，便于测试。

已保留之前的修复：

- `script-src` 显式加入 `cspSource`，允许 Webview 加载插件自身资源。
- 保留脚本 nonce。
- 在 `#root` 中加入 `Loading LoopAgent...` fallback，避免脚本未执行时面板完全空白。

### 3. 减少 source map CSP 噪音

更新 Webview CSP：

- 新增 `connect-src ${cspSource}`。

这样 DevTools 加载本地 source map 时不会继续触发 `default-src 'none'` 的连接拦截。

新增/更新测试：

- `test/webviewHtml.test.ts`

测试目标：

- HTML 包含可见 fallback。
- HTML 正确引用 JS/CSS。
- CSP 包含 `style-src`、`script-src` 和 `connect-src`。

## 验证命令

```powershell
npm test -- test/vscodeApi.test.ts
npm test -- test/webviewHtml.test.ts
```

实际结果：

- `test/vscodeApi.test.ts` 通过，1 个测试通过。
- `test/webviewHtml.test.ts` 通过，1 个测试通过。

后续还需要执行全量验证：

```powershell
npm test
npm run typecheck
npm run compile
```

## 后续观察

如果仍然空白，需要在 VS Code 中运行 `Developer: Toggle Developer Tools`，重点查看：

- 是否仍有 `acquireVsCodeApi()` 二次调用错误。
- 是否有 CSP 拦截 `webview.js` 或 `webview.css`。
- 是否有 React 运行时异常。
## 最终本地页面验证

验证方式：

- 使用独立 VS Code `user-data-dir` 启动 Extension Development Host。
- 通过命令面板执行 `LoopAgent: Open Panel`。
- 使用 CDP 截图确认 Webview 页面可见。
- 输入任务并点击 `Run`，确认假事件流渲染。

最终截图验证结果：

- 页面显示 `LoopAgent` 标题。
- 页面显示 `Idle` 状态。
- 页面显示 `Task prompt` 输入框。
- 页面显示 `Run` 按钮。
- 输入任务后显示 `runId`。
- 事件流显示 4 条：`Run started`、`Building context`、`Calling model placeholder`、`Done`。
- 重复 `Done` 已修复。