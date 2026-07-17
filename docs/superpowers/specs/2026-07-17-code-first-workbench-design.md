# 代码优先智能体工作台设计

## 目标

将现有 `LoopAgent` 侧栏聊天视图调整为代码优先的智能体工作台。界面应让用户快速确认当前任务、Agent 的执行状态和最终回答，同时保持 VS Code 窄侧栏中的输入效率。

设计参考 Cursor 的代码任务层级，并借用 ChatGPT、Claude 的低干扰阅读与输入模式；不复刻任何产品的品牌、图标或页面布局。

## 范围

本次只修改 React Webview 的呈现和可访问性语义：

- 顶部以 Agent 状态和当前模型为主，不再显示冗长的运行 ID。
- 空状态提供简短定位与两个可提交的工作区任务建议。
- 用户任务、Agent 执行过程和最终回答形成清晰层级。
- 运行过程收纳为可展开的状态时间线，完成后默认折叠。
- 输入区固定在底部，模型和思考模式保持为次级控件，发送保留为清晰的文字命令按钮。
- 继续使用 VS Code 主题变量，保证深色、浅色和窄侧栏可读。

## 非目标

- 不修改 `WebviewToHostMessage`、`HostToWebviewMessage` 或 Agent 运行时。
- 不新增模型、文件变更面板、任务历史、持久化或快捷指令系统。
- 不引入图标库、UI 组件库、图片资源或新依赖。
- 不调整 VS Code Extension Host、模型配置和编辑预览功能。

## 用户可见流程

1. 用户打开 `LoopAgent`，看到“就绪”状态、当前模型和可点击的任务建议。
2. 用户选择建议或输入任务后，任务以紧凑的用户请求显示，顶部状态变为“运行中”。
3. Agent 有执行事件时，助手卡片展示简短状态与可展开步骤；流式回答出现后，回答始终优先于步骤阅读。
4. 运行完成后状态回到“就绪”，步骤默认折叠；失败时保留错误内容并使用 VS Code 错误颜色。
5. 用户可立即在固定输入区发起下一轮任务，不需要离开侧栏。

## 布局与组件

```text
状态栏：LoopAgent | 就绪或运行中 | 当前模型
内容区：空状态建议 或 用户请求 + Agent 回答
                  Agent 回答内：状态、可折叠步骤、正文或错误
输入区：多行输入框
        模型菜单 | 思考菜单 | 发送按钮
```

现有 `App` 仍集中管理消息、模型选择和运行状态。仅在该文件内增加少量展示组件或常量，避免为两个任务建议、状态标签或图标建立通用抽象。`styles.css` 负责布局、折叠态和主题变量样式，不以 JavaScript 计算尺寸或主题。

建议任务作为普通 `startTask` 请求发送，复用现有 `handleSubmit` 的校验与运行中禁用语义。用户点击建议后不应跳过空输入校验，也不应并行启动第二个运行。

## 状态与错误处理

- `Ready`、`Running`、`Thinking`、`Responding`、`Done` 和 `Error` 沿用现有运行消息推导，不增加新的跨进程状态。
- 执行步骤在 `thinking`、`streaming` 和 `error` 时默认展开，在 `done` 时默认折叠；用户仍可手动展开。
- 失败保留现有错误文本与 `role="alert"`，不将错误伪装成普通回答。
- 所有交互控件都具有可读名称；模型、思考与发送控制保持键盘可达。

## 验证

- `test/App.test.tsx` 覆盖空状态建议、建议任务提交、运行状态、流式回答、步骤折叠和失败显示。
- 在不超过 `340px` 的侧栏宽度下，顶部、模型控件和发送按钮不溢出或相互覆盖。
- 运行 `npm test -- --run test/App.test.tsx`、`npm run typecheck`、`npm test`、`npm run compile` 和 `git diff --check`。
- 在唯一的 Extension Development Host 中通过 Activity Bar 的 `LoopAgent` 视图检查空状态、一次任务提交、步骤展开和完成后的折叠状态。

## 相关文件

- `src/webview/App.tsx`
- `src/webview/styles.css`
- `test/App.test.tsx`
- `docs/superpowers/plans/2026-07-17-code-first-workbench-plan.md`
