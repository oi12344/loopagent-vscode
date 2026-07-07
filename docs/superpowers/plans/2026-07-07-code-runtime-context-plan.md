# 代码运行时上下文注入实施计划

**Goal:** 在每次真实模型运行前收集一份只读、轻量、可解释的 VS Code 工作区上下文，并作为 system prompt 注入现有模型 runner。

**Architecture:** 新增 `src/extension/runtime/codeRuntimeContext.ts` 负责从 VS Code API 收集上下文快照，新增 `src/extension/runtime/contextPrompt.ts` 负责把快照渲染为模型可读文本。`providerRegistry` 在创建 DeepSeek runner 时注入上下文 prompt provider，`modelRunner` 在每次运行时合并静态 system prompt 和动态上下文。

**Tech Stack:** TypeScript、VS Code Extension API、Vitest、现有 OpenAI-compatible streaming provider。

---

## 范围

本次只实现单次请求的只读上下文快照：

- workspace 名称、根目录相对路径和 package 摘要。
- 当前活动编辑器的相对路径、语言、光标位置、选区文本。
- 无选区时收集光标附近代码片段。
- 打开 tab 的轻量文件列表。
- 错误和警告级别 diagnostics 的精简位置与消息。
- 上下文字符预算和截断标记。

不实现：

- 全仓库扫描或索引。
- 文件修改、终端执行、测试执行等工具能力。
- 长期记忆、向量索引、跨会话缓存。
- Webview 协议或 UI 展示变更。

## 任务

1. 新增 `test/codeRuntimeContext.test.ts`
   - 覆盖活动文件选区优先进入上下文。
   - 覆盖无选区时收集光标附近代码。
   - 覆盖敏感文件名和排除目录不进入上下文。
   - 覆盖 diagnostics 只保留错误和警告。

2. 新增 `test/contextPrompt.test.ts`
   - 覆盖上下文 prompt 包含工作区、活动文件、选区或代码片段、package 摘要。
   - 覆盖上下文为空时返回空字符串，避免无意义 system message。

3. 更新 `test/modelProvider.test.ts`
   - 覆盖 `createModelRunner` 能在运行时追加动态上下文 system prompt。
   - 先运行目标测试并确认失败，失败点应指向缺少动态上下文能力。

4. 新增 `src/extension/runtime/codeRuntimeContext.ts`
   - 导出 `CodeRuntimeContext` 类型和 `collectCodeRuntimeContext`。
   - 收集路径全部转为 workspace 相对路径。
   - 使用字符预算裁剪文本，并记录 `usedChars` 和 `truncated`。

5. 新增 `src/extension/runtime/contextPrompt.ts`
   - 导出 `renderCodeRuntimeContextPrompt`。
   - 输出紧凑、稳定、可测试的中文标题和代码块。
   - 不输出敏感文件内容。

6. 更新 `src/extension/model/modelRunner.ts`
   - 支持 `systemPromptProvider`，每次 run 时动态生成 system prompt。
   - 保持原有 `systemPrompt` 行为兼容。

7. 更新 `src/extension/model/providerRegistry.ts`
   - DeepSeek provider 使用 `collectCodeRuntimeContext` 和 `renderCodeRuntimeContextPrompt`。
   - fake provider 保持原样，继续用于开发 smoke test。

8. 更新文档
   - 在本计划记录实现结果、验证命令和技术债。
   - 如实现取舍偏离设计文档，同步更新 `docs/superpowers/specs/2026-07-06-code-runtime-context-design.md`。

## 验证

按顺序运行：

```powershell
npm test -- --run test/codeRuntimeContext.test.ts test/contextPrompt.test.ts test/modelProvider.test.ts
npm test
npm run typecheck
npm run compile
```

验收标准：

- 目标测试先失败后通过，证明动态上下文能力由本次实现引入。
- 全量 Vitest、TypeScript 类型检查和构建通过。
- 不新增真实 API key、环境变量或 SecretStorage 内容读取。
- 不改变 Webview 消息协议。

## 实施记录

2026-07-07 已完成：

- 新增 `src/extension/runtime/codeRuntimeContext.ts`，实现纯函数上下文收集、路径过滤、选区优先、光标附近片段、package 摘要、diagnostics 过滤和字符预算记录。
- 新增 `src/extension/runtime/contextPrompt.ts`，把上下文快照渲染为模型 system prompt；无有效上下文时返回空字符串。
- 新增 `src/extension/runtime/vscodeRuntimeContext.ts`，从 VS Code API 收集活动编辑器、可见编辑器、打开 tab、diagnostics，并只读取白名单项目文件。
- 更新 `src/extension/model/modelRunner.ts`，支持每次 run 异步生成动态 `systemPromptProvider`，并保持原有静态 `systemPrompt`、`assistantFinished` 和 reasoning signal 文案契约。
- 更新 `src/extension/model/providerRegistry.ts`，DeepSeek runner 注入当前 VS Code 运行时上下文；`fakeAgentRunner` 保持原样。
- 新增 `test/codeRuntimeContext.test.ts`、`test/contextPrompt.test.ts`、`test/modelRunnerContext.test.ts`。

TDD 记录：

- RED：`npm test -- --run test/codeRuntimeContext.test.ts test/contextPrompt.test.ts test/modelRunnerContext.test.ts` 失败，原因是 runtime 模块不存在，`createModelRunner` 也不支持 `systemPromptProvider`。
- GREEN：实现最小功能后，同一目标命令通过，3 个测试文件、7 个用例。
- 回归修正：全量测试发现旧 `modelProvider` 契约要求 `assistantFinished` 和 `Received model reasoning signal`，已恢复并通过目标回归测试。
- 韧性补测：新增上下文构建过程事件和 provider 失败降级测试；RED 后实现 `Building code context` 与 `Code context unavailable`，`npm test -- --run test/modelRunnerContext.test.ts test/modelProvider.test.ts` 通过，2 个测试文件、5 个用例。

当前验证：

- `npm test`：通过，12 个测试文件、33 个用例。
- `npm run typecheck`：通过。
- `npm run compile`：通过。
- 清理扫描：未发现新增真实密钥、临时调试语句或占位标记；既有模型配置仍保留本地环境变量回退能力。
- 本地 VS Code 调试验证：`npm run debug:vscode` 成功启动单一 LoopAgent Extension Development Host，固定使用 `.local-vscode-user-data`、`.local-vscode-extensions` 和远程调试端口 `9333`。
- Webview 验证：DevTools 读取到 `LoopAgent`、`Ready`、输入框、`DeepSeek v4 Flash`、`Think: Off` 和 `Send`，说明 React Webview 已加载。
- 上下文运行路径验证：在同一调试窗口打开 `src/shared/messages.ts` 后发送消息，UI 的 `Process` 展示 `Building code context`、`Calling DeepSeek deepseek-v4-flash` 和 `Run failed`。失败原因是本机未配置 DeepSeek API key，未进入真实模型内容返回阶段。
- 真实 DeepSeek 验证：临时通过进程环境变量向 Extension Development Host 注入 DeepSeek API key，并在 `.local-vscode-user-data/User/settings.json` 仅配置 `loopagent.model.provider=deepseek`、模型名和 thinking 模式；未把 key 写入文件、源码或文档。再次打开 `src/shared/messages.ts` 发送“读取当前活动 TypeScript 文件并说明导出的 message 类型”后，UI 的 `Process` 展示 `Building code context`、`Calling DeepSeek deepseek-v4-flash`、`Done`，助手回答识别出 `WebviewToHostMessage`、`HostToWebviewMessage`、`ModelProviderId`、`ModelThinkingMode` 和 `RunModelSelection`。
- 日志检查：`exthost.log` 显示 `local-dev.loopagent-vscode` 由 `onView:loopagent.chat` 激活，没有新增未处理异常；仍保留一个既有 VS Code CSP warning，需要后续单独判断是否为检测噪音或 webview 初始化时序问题。

实现取舍：

- 核心上下文收集保持纯函数，真实 VS Code API 读取放入 `vscodeRuntimeContext.ts`。这比设计文档中单文件描述多一个 adapter 文件，但测试边界更清晰，也避免 Vitest 依赖真实 `vscode` 模块。
- 第一阶段不把上下文展示到 UI，也不改变 Webview 消息协议。
