# React Webview 最小模块实施计划

## 背景

LoopAgent VS Code 插件当前只有基础命令和 extension host 入口。为了后续承载代码智能体交互，需要先建立一个最小 React Webview UI 基座。

本计划记录已经完成的最小实现，作为后续追溯依据。

## 实施步骤

### 1. 建立测试基线

新增 React 组件测试：

- `test/App.test.tsx`
- `vitest.config.ts`
- `test/setup.ts`

测试先引用尚不存在的 `src/webview/App`，确认 RED 阶段失败原因是模块不存在。

失败验证命令：

```powershell
npx vitest run test/App.test.tsx
```

失败原因：

- `../src/webview/App` 无法解析。

### 2. 安装依赖

新增运行依赖：

- `react`
- `react-dom`

新增开发依赖：

- `@testing-library/react`
- `@testing-library/jest-dom`
- `@vitejs/plugin-react`
- `vitest`
- `jsdom`
- `esbuild`
- `@types/react`
- `@types/react-dom`

### 3. 实现 React Webview 模块

新增文件：

- `src/webview/App.tsx`
- `src/webview/main.tsx`
- `src/webview/styles.css`

`App.tsx` 负责渲染最小界面：

- 标题
- 状态文本
- 任务输入框
- Run 按钮
- 空事件状态

### 4. 接入 VS Code Webview

更新 `src/extension.ts`：

- 注册命令 `loopagent.openPanel`
- 创建 `LoopAgent` Webview panel
- 设置 `localResourceRoots`
- 注入 `dist/webview.js` 和 `dist/webview.css`
- 配置 nonce 和 CSP

### 5. 建立打包流程

新增 `esbuild.js`：

- extension host 代码输出到 `dist/extension.js`
- React Webview 输出到 `dist/webview.js`
- CSS 输出到 `dist/webview.css`

更新 `package.json` 脚本：

- `compile`: `node esbuild.js`
- `watch`: `node esbuild.js --watch`
- `test`: `vitest run`
- `typecheck`: `tsc --noEmit -p ./`

### 6. 验证

最终验证命令：

```powershell
npm test -- test/App.test.tsx
npm run typecheck
npm run compile
```

验证结果：

- `test/App.test.tsx` 通过，1 个测试通过。
- `npm run typecheck` 通过。
- `npm run compile` 通过。

## 清理记录

已避免引入以下内容：

- 未使用的 agent runtime 代码。
- 临时 UI 状态机。
- 独立前端应用脚手架。
- 复杂组件拆分。

当前保留的后续扩展点：

- `src/webview/App.tsx` 中的任务输入状态。
- `src/extension.ts` 中的 Webview 创建逻辑。
- `dist` 构建产物由 `npm run compile` 生成。

## 技术债

当前 `dist/webview.js` 在开发模式下包含 source map，文件较大。这对本地开发可接受。

发布前应考虑：

```powershell
node esbuild.js --production
```

并根据 VS Code 插件发布流程决定是否加入 `.vscodeignore`。
