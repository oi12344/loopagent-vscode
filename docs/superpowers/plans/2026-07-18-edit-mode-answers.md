# Edit 模式可直接问答

## 目标

`Edit` 表示允许模型编辑工作区，而不是要求每轮必须编辑。模型可直接回答解释性问题；实际调用 `applyEdit` 时仍打开 VS Code 编辑审查。

## 范围与取舍

- 删除 `reactAgentRunner` 中强制 `readFile`、`applyEdit` 和未打开审查即报错的调度。
- 保持界面选中的 `Edit` 模式，避免编辑与后续提问之间发生隐式模式切换。
- 不改变 `applyEdit` 的预览、确认和应用流程。
- 模式选中态使用 VS Code 主按钮色、前景色和内描边，确保在深色主题下可辨识。
- 对跨文件、公共行为或约定不清的改动，先搜索最相近实现，再读取其实现、直接调用方、类型/数据定义和测试；明确单文件改动可跳过。

## 验证

- `test/reactAgentRunner.test.ts`：Edit 模式可以直接产生最终回答，也可由模型自行选择 `applyEdit`。
- `test/App.test.tsx`：编辑任务完成后仍保持 Edit 模式。
- 运行受影响测试、全量测试、类型检查、编译和 `git diff --check`。

## 完成记录

- 已通过受影响测试、全量 `npm test`（51 个文件、312 个用例）、类型检查和编译。
- 已在 `npm run debug:vscode` 启动的 Extension Development Host 中确认 LoopAgent 面板和 Edit 模式已加载；该 Electron Webview 的 CDP DOM/输入焦点不可访问，未通过自动化额外发起模型请求。
- 已在深色主题实际窗口中确认 Edit 选中态使用高对比填充和内描边。
- 已验证真实模型请求的系统提示包含跨文件或约定不清变更的代码学习规则。
