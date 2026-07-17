# 右侧副侧边栏设计

## 目标

让 LoopAgent Chat 默认出现在 VS Code 的右侧副侧边栏，与用户要求的 Copilot 式对话栏位置一致。

## 根因

当前 `package.json` 将 `loopagent` 注册在 `contributes.viewsContainers.activitybar`。该贡献点属于主侧边栏；用户当前的主侧边栏在窗口左侧，因此 LoopAgent 也显示在左侧。

## 方案

将视图容器注册点改为 `contributes.viewsContainers.secondarySidebar`。本机 VS Code 的扩展贡献点实现只识别 `activitybar`、`panel` 和 `secondarySidebar`；`auxiliarybar` 不是有效的自定义容器键。保留容器 ID `loopagent`、视图 ID `loopagent.chat` 和现有 `loopagent.focusChat` 命令，因此 Webview provider、任务运行和消息布局不需要改动。

新安装或重置视图位置时，LoopAgent 会显示在右侧副侧边栏。VS Code 仍允许用户通过自身的“移动视图”功能覆盖该位置，这是宿主产品的预期行为。

## 范围

- 修改 `package.json` 的视图容器贡献点。
- 更新 `test/packageManifest.test.ts` 的 manifest 契约断言。
- 补充实施计划和验证记录。

不改动 Webview HTML/CSS、模型推理流、命令 ID 或运行时逻辑。

## 验证

1. 先让 manifest 契约测试在旧的 `activitybar` 注册下失败。
2. 改为 `auxiliarybar` 后运行该测试、完整测试、类型检查和编译。
3. 重新打包安装 VSIX，在 VS Code 中确认 LoopAgent 位于右侧副侧边栏。
