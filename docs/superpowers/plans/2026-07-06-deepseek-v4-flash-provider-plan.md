# DeepSeek v4 flash Provider 接入实施计划

SUB-SKILL: task-by-task

## Goal

在不硬编码 provider 的前提下，把 `deepseek-v4-flash` 接入现有 `AgentRunner` 链路，并保留未来扩展其他模型供应商的边界。

## Architecture

模型能力进入 `src/extension/model/`，通过 `ModelProvider` 抽象和 `modelRunner` 适配到已有 `AgentRunner`。DeepSeek 只作为 `providers/deepseekProvider.ts` 的一个实现；`extension.ts` 根据 VS Code 配置选择 fake runner 或真实模型 runner。

## Tech Stack

TypeScript、VS Code Extension API、VS Code SecretStorage、Node/Extension Host `fetch`、Vitest、DeepSeek OpenAI-compatible Chat Completion API。

## Tasks

1. 新增模型类型红灯测试：
   - 创建 `test/modelProvider.test.ts`。
   - 验证 `createModelRunner` 会把一次 task 转成 user message，并把最终模型回答转成 `agentEvent`。
   - 验证缺少密钥时返回可读错误，不发起 HTTP 请求。
   - 运行：
     ```powershell
     npm test -- test/modelProvider.test.ts
     ```
   - 预期：因模型层尚不存在而失败。

2. 新增 OpenAI-compatible client 红灯测试：
   - 创建 `test/openAiCompatibleClient.test.ts`。
   - 验证请求 URL 是 `<baseUrl>/chat/completions`。
   - 验证请求头包含 `Authorization: Bearer <redacted-test-key>`。
   - 验证 body 包含 `model`、`messages`、`stream`、DeepSeek `thinking` 扩展。
   - 验证 SSE `data:` chunk 能聚合 content delta，并忽略或内部记录 `reasoning_content`。
   - 验证 `401`、`402`、`422`、`429`、`500`、`503` 映射为稳定错误类型。

3. 实现模型基础类型：
   - 新增 `src/extension/model/types.ts`。
   - 定义 `ModelProvider`、`ModelRequest`、`ModelMessage`、`ModelStreamEvent`、`ModelProviderError`。

4. 实现通用 OpenAI-compatible client：
   - 新增 `src/extension/model/openAiCompatibleClient.ts`。
   - 使用注入式 `fetch`，测试不访问真实网络。
   - 支持 `AbortSignal`。
   - 支持非流式与流式解析；DeepSeek 第一版使用流式 client 后在 runner 层聚合展示。

5. 实现 DeepSeek provider：
   - 新增 `src/extension/model/providers/deepseekProvider.ts`。
   - 默认配置：
     - `baseUrl: "https://api.deepseek.com"`
     - `model: "deepseek-v4-flash"`
     - `thinking: { type: "disabled" }`
   - 不在任何文件里写入真实 API key。

6. 实现密钥与配置读取：
   - 新增 `src/extension/model/modelConfig.ts`。
   - 读取 `loopagent.model.provider`、`loopagent.model.model`、`loopagent.model.baseUrl`、`loopagent.model.thinking`。
   - 读取 VS Code `SecretStorage`，开发时允许 fallback 到 `DEEPSEEK_API_KEY`。

7. 更新 `package.json` contributes：
   - 新增模型配置项。
   - 新增 `loopagent.setModelApiKey` 和 `loopagent.clearModelApiKey` 命令。

8. 更新 `src/extension.ts`：
   - 注册密钥设置/清除命令。
   - `loopagent.openPanel` 根据 provider 配置选择 `fakeAgentRunner` 或模型 runner。
   - 保持面板关闭、新任务启动时取消旧 run 的行为。

9. 补充文档：
   - 更新 `docs/superpowers/specs/2026-07-06-model-provider-deepseek-design.md`，记录实现中发生的取舍变化。
   - 更新本计划的实际验证记录。
   - 如用户确认需要，也更新 `README.md` 的本地模型配置说明。

10. 验证：
    ```powershell
    npm test -- --run
    npm run typecheck
    npm run compile
    ```

11. 真实 E2E 验证：
    - 使用 `testing-vscode-extension-e2e` 技能。
    - 启动：
      ```powershell
      npm run debug:vscode
      ```
    - 在 Extension Development Host 中：
      - 设置 provider 为 `deepseek`。
      - 通过 `LoopAgent: Set Model API Key` 输入密钥。
      - 打开 `LoopAgent: Open Panel`。
      - 发送一条短任务。
      - 验证面板出现真实模型回答，而不是 `Calling model placeholder`。

12. 清理：
    - 确认没有 API key 出现在源码、文档、测试、构建产物。
    - 确认没有调试截图、临时脚本、未使用导出或过期待办标记。
    - 真实验证后建议用户轮换已暴露在聊天里的 API key。

## 实际实现记录

2026-07-06 已完成以下源码变更：

- 新增 `src/extension/model/types.ts`，定义模型 provider、请求、事件和错误类型。
- 新增 `src/extension/model/openAiCompatibleClient.ts`，实现 OpenAI-compatible `POST /chat/completions` 流式请求与 SSE 解析。
- 新增 `src/extension/model/providers/deepseekProvider.ts`，默认使用 `https://api.deepseek.com`、`deepseek-v4-flash`、`thinking.disabled`。
- 新增 `src/extension/model/modelRunner.ts`，把 `ModelProvider` 适配成现有 `AgentRunner`。
- 新增 `src/extension/model/modelConfig.ts` 和 `providerRegistry.ts`，读取 VS Code 配置、SecretStorage 与开发环境变量。
- 更新 `src/extension.ts`，注册 `LoopAgent: Set Model API Key`、`LoopAgent: Clear Model API Key`，并在面板运行时按配置选择 fake 或 DeepSeek runner。
- 更新 `package.json`，新增模型配置项和命令贡献。
- 新增 `test/modelProvider.test.ts` 和 `test/openAiCompatibleClient.test.ts`。

## 实际验证记录

2026-07-06 已完成以下验证：

- `npm test -- test/modelProvider.test.ts test/openAiCompatibleClient.test.ts`：通过，2 个测试文件、9 个测试通过。
- `npm test -- --run`：通过，7 个测试文件、18 个测试通过。
- `npm run typecheck`：通过。
- `npm run compile`：通过。
- 使用真实 VS Code Extension Development Host 验证默认 `fake` provider：通过，面板显示 `Run started`、`Building context`、`Calling model placeholder`、`Done`。
- 使用真实 VS Code Extension Development Host 验证 `deepseek` provider 无密钥路径：通过，面板显示 `Calling DeepSeek deepseek-v4-flash`，随后显示 `DeepSeek API key is not configured`。
- 真实 DeepSeek API 最小验证已完成：使用临时进程环境变量发送 `hello` 到 `deepseek-v4-flash`，接口返回 `200`，内容为 `Hello! How can I help you today?`，usage 为 `prompt_tokens: 5`、`completion_tokens: 9`、`total_tokens: 14`。
- 该真实验证没有把 API key 写入源码、文档、测试或配置文件。后续在 VS Code 调试窗口中使用真实 provider 时，仍需通过 `LoopAgent: Set Model API Key` 手动输入，或由用户在本地环境中设置 `DEEPSEEK_API_KEY`。

## 技术债与后续事项

- `429`、`500`、`503` 当前只做错误映射，不做自动退避重试。后续接入长任务或真实高频调用时，再增加可测试的 retry 策略。
- 当前 Webview 仍以单条 `agentEvent` 展示聚合后的最终回答；流式 token 级 UI 需要单独设计消息协议。
- 真实 DeepSeek 调用需要密钥进入运行时。为避免泄露，密钥必须通过 `LoopAgent: Set Model API Key` 手动输入，或由用户在本地环境中设置 `DEEPSEEK_API_KEY`。
