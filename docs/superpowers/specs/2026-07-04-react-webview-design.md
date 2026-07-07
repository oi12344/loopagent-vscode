# React Webview 最小模块设计

## 目标

为 LoopAgent VS Code 插件落地一个最小 React Webview 界面，作为后续代码智能体交互面板的基础。

该模块需要让用户能够从 VS Code 命令面板打开 `LoopAgent` 面板，并看到一个可扩展的任务输入界面。

## 非目标

本阶段不实现以下能力：

- 不接入 LLM 模型调用。
- 不实现 agent runtime 状态机。
- 不执行文件读写、shell、patch 或 git 操作。
- 不实现真实事件流或任务执行结果。
- 不做复杂布局系统或主题定制。

## 用户可见行为

新增命令：

- `LoopAgent: Open Panel`

用户运行该命令后，VS Code 打开一个 Webview 面板，面板中显示：

- 标题 `LoopAgent`
- 状态文本 `Idle`
- 任务输入框
- `Run` 按钮
- 空事件状态 `No agent events yet.`

输入框为空时，`Run` 按钮禁用；输入内容后按钮可用。

## 涉及文件

- `src/extension.ts`：注册 `loopagent.openPanel` 命令，创建 VS Code Webview，并加载打包后的 JS/CSS。
- `src/webview/App.tsx`：React 组件入口，渲染最小任务输入界面。
- `src/webview/main.tsx`：浏览器侧 React 挂载入口。
- `src/webview/styles.css`：Webview 基础样式。
- `esbuild.js`：同时打包 VS Code extension 和 React Webview。
- `test/App.test.tsx`：React 组件行为测试。
- `vitest.config.ts`：React 测试环境配置。
- `test/setup.ts`：测试断言扩展配置。
- `package.json`：新增 React、测试和构建脚本依赖。

## 关键设计决策

### 使用 React 作为 Webview UI

React 只用于 VS Code Webview 中的交互界面，不进入 extension host 的核心逻辑。

这样可以让 UI 迭代保持灵活，同时避免把未来 agent runtime 与 VS Code UI 绑定。

### 使用 esbuild 而不是 Vite 应用脚手架

当前目标是 VS Code 插件内嵌 Webview，不是独立前端应用。

`esbuild.js` 同时负责：

- 打包 `src/extension.ts` 到 `dist/extension.js`
- 打包 `src/webview/main.tsx` 到 `dist/webview.js`
- 输出 Webview 样式到 `dist/webview.css`

这样构建链路更短，产物也更贴近 VS Code 插件运行方式。

### Webview CSP

`src/extension.ts` 使用 `panel.webview.cspSource` 和脚本 nonce 设置 Content Security Policy。

Webview 只允许加载插件自身 `dist` 目录下的资源，不开放远程脚本。

### UI 保持最小

本阶段只保留任务输入和事件空状态。

原因是 agent runtime 尚未实现，过早设计复杂事件列表、权限弹窗或运行状态会制造无效代码。

## 验证方式

已使用 TDD 方式验证 React 模块：

```powershell
npm test -- test/App.test.tsx
```

验证内容：

- 渲染标题 `LoopAgent`
- 渲染任务输入框
- 渲染 `Run` 按钮
- 渲染空事件状态

同时执行：

```powershell
npm run typecheck
npm run compile
```

用于确认 TypeScript 类型检查和 extension/webview 打包通过。

## 后续工作

后续接入 agent runtime 时，应优先补以下能力：

- Webview 与 extension host 的消息协议。
- 用户输入任务后发送 `startTask` 消息。
- extension host 创建 agent run，并向 Webview 推送事件。
- Webview 渲染 agent event log。
- Run 按钮进入运行态、禁用态和失败态。

这些变更必须另行补充设计或计划文档。
