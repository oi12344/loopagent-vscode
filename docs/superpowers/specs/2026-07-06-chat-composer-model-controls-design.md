# 对话输入区与模型控制设计

## 背景

LoopAgent 当前已经有真实对话 UI 和 DeepSeek v4 flash 流式返回能力。下一步需要让输入框固定在下方，并允许用户在发送前选择模型和是否启用深度思考。

本次先通过 VS Code E2E 探索本机可见的 Chat/Agents UI，再整改方案。标准扩展列表未发现 `GitHub.copilot` 或 `GitHub.copilot-chat`，因此观察对象是 VS Code 1.127 Extension Development Host 中可打开的内置 Chat/Agents 面板；其中模型入口显示为 `Models, sign in to use Copilot`。

用户确认后，LoopAgent 不能继续作为编辑器 tab 展示。聊天入口必须改为 VS Code 侧边栏 View，形态接近 Chat/Copilot 的侧边体验。

## E2E 观察

使用 `Chat: Open Chat` 打开右侧 Chat 面板后，观察到：

- Chat 位于 Secondary Side Bar，标题为 `CHAT`，空态标题为 `Build with Agent`。
- 输入区固定在面板底部，消息区独立滚动。
- composer 是一个带边框的输入容器，placeholder 为 `Describe what to build`。
- composer 底部工具条包含 `Add Context`、`Set Agent`、`Models`、`Configure Tools`、发送按钮。
- composer 下方还有更低优先级的状态 chip，例如 `Local` 和 `Default Approvals`。
- `Models` 不是页面顶部设置项，而是 composer 工具条中的小 chip；点击后在 chip 上方打开小型 action widget。
- 未登录时模型菜单只显示 `Sign in to use Copilot...`，说明模型选择入口支持空态/不可用态。
- `Set Agent` 也是底部工具条小弹层，选项包含名称、图标和快捷键。
- `Default Approvals` 是底部状态 chip，菜单选项包含标题和说明，例如默认审批、绕过审批、自动驾驶预览。
- `Configure Tools` 是较重的居中列表浮层，适合复杂工具配置，不适合本次模型/思考开关。

## 设计原则

- 输入区必须固定在底部，聊天内容独立滚动。
- 模型和深度思考应放在 composer 内或紧邻 composer 的工具条，避免放到顶部全局设置区。
- 控件要像 VS Code Chat 一样轻量：chip、图标按钮、小弹层、标题加说明。
- 不复制 Copilot 品牌、图标或专有文案，只吸收交互结构。
- 深度思考仍只影响请求配置，不展示原始思维链。

## 整改后的 UI 方案

LoopAgent Webview 迁移为 `WebviewViewProvider` 承载的侧边栏 View，不再默认使用 `createWebviewPanel` 打开编辑器 tab。VS Code 稳定贡献点可以将自定义 View Container 放在 Activity Bar；用户仍可按 VS Code 原生能力把 View 移动到右侧 Secondary Side Bar。

侧边栏 View 内部采用三段布局：

1. 顶部 header：`LoopAgent`、运行状态、当前 run id。
2. 中间 chat log：独立滚动，展示用户消息、助手消息、过程区和错误。
3. 底部 composer：固定在底部，包含输入框、工具条和发送按钮。

扩展贡献点：

- `viewsContainers.activitybar`: 新增 `loopagent` 容器，标题 `LoopAgent`。
- `views.loopagent`: 新增 `loopagent.chat` View，标题 `Chat`。
- `activationEvents`: 新增 `onView:loopagent.chat`。
- 命令从 `LoopAgent: Open Panel` 调整为 `LoopAgent: Focus Chat`，聚焦侧边栏 View。

composer 结构：

- 第一行：多行输入框。
- 第二行左侧：模型 chip，例如 `DeepSeek v4 Flash`；深度思考 chip，例如 `Think: Off` / `Think: On`。
- 第二行右侧：发送按钮。

模型菜单：

- `Fake local`：用于本地开发，不支持深度思考。
- `DeepSeek v4 Flash`：provider 为 `deepseek`，model 为 `deepseek-v4-flash`，支持深度思考。

深度思考菜单：

- `Off`：请求使用 `thinking: disabled`。
- `On`：请求使用 `thinking: enabled`。
- 当模型不支持时禁用，并显示 `Not supported by this model`。

## 协议设计

`startTask` 从只携带 `task` 扩展为可选运行设置：

```ts
{
  type: "startTask";
  task: string;
  model?: {
    provider: "fake" | "deepseek";
    model: string;
    thinking: "disabled" | "enabled";
  };
}
```

扩展端优先使用本次消息里的 `model`；如果不存在，则回退到 VS Code workspace configuration。这样保留旧协议兼容，也便于以后增加更多 provider。

## 取舍

- 不继续使用编辑器 tab 作为默认聊天入口，因为它和 Copilot/Chat 的侧边体验不一致。
- 不承诺强制打开右侧 Secondary Side Bar，因为 VS Code 稳定扩展贡献点没有直接固定到右侧栏的能力；先贡献为真实侧边栏 View。
- 不做顶栏模型选择，因为 E2E 中模型入口贴近 composer，属于本次输入的上下文。
- 不做复杂工具配置，因为本次需求不是 tool selection。
- 不做 Copilot agent picker，因为当前 LoopAgent 还没有多个 agent 实现。
- 不把深度思考作为全局设置写死；它是本次发送配置，后续可以再决定是否持久化上次选择。

## 验证方式

- Webview 测试覆盖固定底部 composer、模型 chip、深度思考 chip、禁用态和 `startTask` payload。
- Manifest 测试覆盖 `viewsContainers.activitybar`、`views.loopagent`、`onView:loopagent.chat` 和 `LoopAgent: Focus Chat`。
- 扩展测试覆盖消息内 model override 优先于 workspace configuration。
- `npm test -- --run`
- `npm run typecheck`
- `npm run compile`
- VS Code E2E 验证 LoopAgent 以侧边栏 View 打开，composer 固定在底部，选择 `DeepSeek v4 Flash` 和 `Think: On` 后发送真实消息。
