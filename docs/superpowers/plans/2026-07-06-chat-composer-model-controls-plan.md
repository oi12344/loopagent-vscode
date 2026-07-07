# 对话输入区与模型控制实施计划

SUB-SKILL: task-by-task

## Goal

将 LoopAgent 从编辑器 tab 迁移为侧边栏 Chat View，并在固定底部 composer 中提供模型选择和深度思考开关。

## Architecture

`package.json` 贡献 `viewsContainers.activitybar` 和 `views.loopagent`；`src/extension.ts` 注册 `WebviewViewProvider` 并提供 `LoopAgent: Focus Chat` 命令；`src/shared/messages.ts` 扩展 `startTask` 的可选模型配置；`src/extension/model/providerRegistry.ts` 支持根据本次请求创建 runner；`src/webview/App.tsx` 管理模型和 thinking 状态；`src/webview/styles.css` 实现侧边栏尺寸下的固定底部 composer 和小型菜单。

## Tech Stack

TypeScript、React、VS Code Webview、Vitest、Testing Library、esbuild、VS Code Extension Development Host。

## Task 1: Manifest RED 测试

Create: `test/packageManifest.test.ts`

新增断言：

- `activationEvents` 包含 `onView:loopagent.chat`。
- `contributes.viewsContainers.activitybar` 包含 `loopagent`。
- `contributes.views.loopagent` 包含 `loopagent.chat`。
- 命令包含 `loopagent.focusChat`，标题为 `LoopAgent: Focus Chat`。
- 默认命令列表不再包含 `loopagent.openPanel`。

Run: `npm test -- --run test/packageManifest.test.ts`

Expected: fails because 当前 manifest 仍是 `loopagent.openPanel` 和 editor tab 入口。

## Task 2: Webview RED 测试

Modify: `test/App.test.tsx`

新增断言：

- composer 使用 `role="form"` 或可定位区域，并在 DOM 上有固定底部布局类。
- 初始显示模型 chip `DeepSeek v4 Flash` 和 thinking chip `Think: Off`。
- 选择 `DeepSeek v4 Flash` 后，`Think` 控件可用。
- 选择 `Fake local` 后，`Think` 控件禁用或显示不支持。
- 发送消息时 `postMessage` 包含 `model.provider`、`model.model`、`model.thinking`。

Run: `npm test -- --run test/App.test.tsx`

Expected: fails because 当前 UI 没有模型和 thinking 控件。

## Task 3: 扩展端 RED 测试

Modify: existing extension/model tests or add a focused provider registry test.

新增断言：

- 当 `startTask` 携带 `model.provider=deepseek`、`model.model=deepseek-v4-flash`、`model.thinking=enabled` 时，runner 使用该配置。
- 旧 `startTask` 不携带 model 时继续使用 workspace configuration。

Run: targeted test command.

Expected: fails because 当前 `startTask` 不支持 model override。

## Task 4: 侧边栏入口迁移

Modify: `package.json`
Modify: `src/extension.ts`

- 增加 `viewsContainers.activitybar` 和 `views.loopagent`。
- 增加 `onView:loopagent.chat`。
- 使用 `vscode.window.registerWebviewViewProvider("loopagent.chat", provider, { webviewOptions: { retainContextWhenHidden: true } })`。
- `LoopAgent: Focus Chat` 执行 `workbench.view.extension.loopagent`，必要时再执行 `loopagent.chat.focus`。
- 删除默认 `createWebviewPanel` tab 入口。

Run: `npm test -- --run test/packageManifest.test.ts`

Expected: pass。

## Task 5: 协议与 runner factory

Modify: `src/shared/messages.ts`
Modify: `src/extension/model/modelConfig.ts`
Modify: `src/extension/model/providerRegistry.ts`
Modify: `src/extension.ts`

- 定义 `RunModelSelection` 类型。
- `WebviewToHostMessage.startTask` 增加可选 `model`。
- 增加从 model selection 创建 runner 的函数。
- 对无效 provider 做保守回退或错误提示。

Run: targeted extension tests.

Expected: pass。

## Task 6: Webview UI

Modify: `src/webview/App.tsx`
Modify: `src/webview/styles.css`

- 将 composer 固定在底部。
- 输入框下方增加工具条。
- 模型 chip 打开小菜单，提供 `DeepSeek v4 Flash` 与 `Fake local`。
- thinking chip 打开小菜单或直接切换 `On/Off`。
- unsupported 模型下禁用 thinking 控件。
- 发送时带上当前模型配置。

Run: `npm test -- --run test/App.test.tsx`

Expected: pass。

## Task 7: 全量验证

Run:

```powershell
npm test -- --run
npm run typecheck
npm run compile
```

Expected: all pass。

## Task 8: VS Code E2E

Run: `npm run debug:vscode`

在唯一 Extension Development Host 中：

1. 执行 `LoopAgent: Focus Chat`。
2. 验证 LoopAgent 在侧边栏 View 中展示，不创建编辑器 tab。
3. 验证输入区固定在底部。
4. 打开模型菜单，选择 `DeepSeek v4 Flash`。
5. 打开或切换 `Think: On`。
6. 使用真实 DeepSeek key 发送 `hello`。
7. 验证 UI 显示 provider、过程区、thinking 信号和真实回答。

## 验证记录

2026-07-06 已完成：

- RED：`npm test -- --run test/packageManifest.test.ts` 先失败，原因为 manifest 仍使用 `loopagent.openPanel` 和 editor tab 入口。
- RED：`npm test -- --run test/App.test.tsx` 先失败，原因为 Webview 没有模型 chip、thinking chip 和 per-run model payload。
- RED：`npm test -- --run test/modelConfig.test.ts` 先失败，原因为纯 runtime config 模块尚不存在。
- GREEN：`npm test -- --run test/modelConfig.test.ts` 通过，3 个测试通过。
- GREEN：`npm test -- --run test/packageManifest.test.ts` 通过，1 个测试通过。
- GREEN：`npm test -- --run test/App.test.tsx` 通过，6 个测试通过。
- 全量：`npm test -- --run` 通过，9 个测试文件、25 个测试通过。
- 类型检查：`npm run typecheck` 通过。
- 构建：`npm run compile` 通过。
- E2E：使用 `npm run debug:vscode` 启动唯一 Extension Development Host，执行 `LoopAgent: Focus Chat` 后，LoopAgent 显示在 Activity Bar 侧边栏 View；编辑器 tab 列表只有 `Welcome`，没有创建 LoopAgent editor tab。
- E2E：侧边栏中选择 `DeepSeek v4 Flash`，切换 `Think: On`，发送 `hello`，真实返回中显示 `DeepSeek deepseek-v4-flash`、`Process`、`Received model reasoning signal` 和模型回答。
- 调试发现并修复：第一次 E2E 暴露 per-run `deepseek` 选择未重新获取 deepseek API key 的问题；已补充 provider 切换丢弃旧 key 的测试，并调整 `getModelRuntimeConfig` 为最终 provider 重新取 key。
- 扫描：执行敏感 key、调试语句、临时文件和占位标记扫描，未发现匹配；文档不记录真实 key 片段。
- 清理：E2E 临时截图已删除。
