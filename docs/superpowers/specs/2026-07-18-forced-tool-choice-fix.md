# 强制工具调用修复：只暴露被强制的函数

## 背景

编辑模式下，用户发指令后频繁报错 **"Edit review was not opened"**，编辑审查页始终打不开。

通过在扩展运行时加文件日志（写入系统临时目录 `loopagent-debug.log`）逐步定位，并直接调用 DeepSeek API 复现，确认了根因。

## 根因

运行器 [reactAgentRunner.ts](../../../src/extension/agent/reactAgentRunner.ts) 的编辑流程会在指定步骤用
`tool_choice: {type:"function", function:{name:"applyEdit"}}` **强制模型调用 applyEdit**。

但实测 **DeepSeek `deepseek-v4-flash` 不遵守"强制调用特定函数"的约束**：只要 `readFile` 等其它工具仍在
`tools` 列表里，模型就会改调 `readFile`（把大文件分段读完），把 `maxSteps` 耗光，applyEdit 从未被调用，
最终抛出 "Edit review was not opened"。

直接 API 验证：

- 强制 applyEdit + 工具列表含 readFile → 模型返回 `readFile`（无视强制）
- 强制 applyEdit + 工具列表只含 applyEdit → 模型返回 `applyEdit`（正确）

## 修复

[openAiReactModelTurn.ts](../../../src/extension/agent/openAiReactModelTurn.ts)：当 `toolChoice` 是指定具体函数的对象时，
把发送给 provider 的 `tools` 过滤成**只剩该函数**。模型没有其它工具可选，只能调用被强制的函数。

该改动对所有 provider 生效，语义等价（强制某函数时只提供该函数），且更健壮，无副作用。

## 验证

- 单元测试：[test/openAiReactModelTurn.test.ts](../../../test/openAiReactModelTurn.test.ts) 新增
  "only exposes the forced tool when tool choice targets a specific function"。
- 真机端到端：安装 VSIX 后，Edit 模式发"在 create_app 方法加日志输出"，审查页正常打开，
  点「接受全部」后文件成功写入（日志确认 `apply.applied: true`）。

## 相关未决项（本次未处理）

- **思考过程不流式**：`createOpenAiReactModelTurn` 把整个流缓冲成一次性 `Promise` 结果，
  reasoning/content 在完成后一次性下发，而非逐字。属于 `ReactModelTurn` 契约的架构限制，需单独设计。
- **CodeLens 审查按钮不渲染**：diff 编辑器里未出现「接受全部/放弃」文字链接（`provideCodeLenses` 未被调用），
  目前只能用编辑器标题栏图标接受/放弃，容易点错。待后续处理。
