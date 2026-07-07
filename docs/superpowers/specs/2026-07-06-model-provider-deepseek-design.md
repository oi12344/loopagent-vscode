# 模型 Provider 抽象与 DeepSeek v4 flash 接入设计

## 目标

在现有 `AgentRunner` 边界下接入真实模型，同时避免把 DeepSeek 细节写死在运行链路里。DeepSeek v4 flash 是第一个 provider，后续可以继续接入 OpenAI-compatible provider、OpenAI、Anthropic 或本地 runtime。

## 官方文档依据

- DeepSeek Quick Start：`https://api-docs.deepseek.com/`
- DeepSeek Models & Pricing：`https://api-docs.deepseek.com/quick_start/pricing`
- DeepSeek Create Chat Completion：`https://api-docs.deepseek.com/api/create-chat-completion`
- DeepSeek Thinking Mode：`https://api-docs.deepseek.com/guides/thinking_mode`
- DeepSeek Error Codes：`https://api-docs.deepseek.com/quick_start/error_codes`
- DeepSeek Rate Limit & Isolation：`https://api-docs.deepseek.com/quick_start/rate_limit`

已核对的关键点：

- OpenAI Format base URL 是 `https://api.deepseek.com`。
- Chat Completion 路径是 `POST /chat/completions`。
- 当前模型 ID 包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- `deepseek-chat` 和 `deepseek-reasoner` 将在 `2026-07-24 15:59 UTC` 废弃，并兼容映射到 `deepseek-v4-flash` 的非思考/思考模式。
- `thinking` 参数支持 `enabled` / `disabled`，默认是 `enabled`。
- 流式响应使用 SSE，并以 `data: [DONE]` 结束；`stream_options.include_usage` 可在结束前返回 usage。
- 典型错误包括 `401` 认证失败、`402` 余额不足、`422` 参数错误、`429` 速率限制、`500` 服务错误、`503` 服务过载。

## 安全原则

用户在会话中提供的 API key 不写入源码、文档、测试、`package.json` 默认值或构建产物。

第一版按以下优先级读取密钥：

1. VS Code `SecretStorage` 中的 provider 密钥。
2. 开发环境变量，例如 `DEEPSEEK_API_KEY`。
3. 未配置时返回 `runFailed`，提示用户通过命令或环境变量配置。

因为密钥已经出现在聊天上下文中，完成接入后建议用户在 DeepSeek 平台轮换一次密钥。

## 抽象边界

新增模型层，不让 `AgentRunner` 直接依赖 DeepSeek HTTP 结构：

- `src/extension/model/types.ts`
  - `ModelProvider`
  - `ModelRequest`
  - `ModelMessage`
  - `ModelStreamEvent`
  - `ModelProviderConfig`
- `src/extension/model/openAiCompatibleClient.ts`
  - 通用 OpenAI-compatible Chat Completion HTTP client。
  - 负责请求、SSE 解析、错误归一化、abort。
- `src/extension/model/providers/deepseekProvider.ts`
  - DeepSeek provider 配置和 body 细节。
  - 默认 `model: "deepseek-v4-flash"`。
  - 默认 `thinking: { type: "disabled" }`，避免把 `reasoning_content` 暴露到当前简单 UI。
- `src/extension/model/modelRunner.ts`
  - 把 `ModelProvider` 适配为现有 `AgentRunner`。
  - 当前 UI 仍使用 `agentEvent` 显示最终回答；内部保留 delta 事件，后续可扩展到流式 UI。
- `src/extension/model/providerRegistry.ts`
  - 根据 VS Code 配置选择 provider。

## VS Code 配置与命令

新增配置项：

- `loopagent.model.provider`：默认 `fake`，可选 `fake`、`deepseek`。
- `loopagent.model.model`：默认 `deepseek-v4-flash`。
- `loopagent.model.baseUrl`：默认跟随 provider，DeepSeek 为 `https://api.deepseek.com`。
- `loopagent.model.thinking`：默认 `disabled`，可选 `disabled`、`enabled`。

新增命令：

- `LoopAgent: Set Model API Key`
  - 弹出 password input。
  - 按 provider 存入 VS Code `SecretStorage`。
- `LoopAgent: Clear Model API Key`
  - 删除当前 provider 密钥。

`LoopAgent: Open Panel` 仍是主入口。第一版不新增复杂设置 UI，避免 Webview 和 runtime 同时扩张。

## Runner 行为

一次任务运行转换为模型请求：

1. `runStarted`
2. `agentEvent: Calling deepseek-v4-flash`
3. 模型 provider 执行请求
4. `agentEvent: <final answer>`
5. `runFinished`

异常转换：

- 缺少密钥：`runFailed`，说明配置方式。
- `401`：`runFailed`，提示密钥无效。
- `402`：`runFailed`，提示余额不足。
- `422`：`runFailed`，提示请求参数错误。
- `429`、`500`、`503`：第一版映射为稳定错误并通过 `runFailed` 展示。自动退避重试暂不启用，作为后续技术债记录在计划文档中。

## 取舍

- 第一版使用 `fetch` 而不是引入 OpenAI SDK，减少依赖并保持 provider 抽象可控。
- 第一版内部支持 SSE，但 UI 先显示聚合后的最终回答，避免每个 token 变成一条事件。
- 第一版默认关闭 Thinking Mode，不展示 `reasoning_content`。后续需要思考模式时，只显示状态或摘要，不直接把 CoT 当普通内容输出。
- 第一版不接 tool calls。DeepSeek 官方支持 tool calls，但工具执行需要独立设计权限、沙箱和 UI 状态。
- 第一版默认 provider 仍为 `fake`，必须显式把 `loopagent.model.provider` 改为 `deepseek` 才会调用真实模型。

## 验证方式

- 单元测试覆盖配置解析、OpenAI-compatible 请求体、SSE 解析、错误映射、密钥缺失。
- Provider 层使用 fake `fetch`，避免测试泄露密钥或真实扣费。
- 真实 E2E 验证使用 `testing-vscode-extension-e2e` 技能，在 VS Code Extension Development Host 中跑一次 DeepSeek 请求。
- 真实 E2E 前要求通过 `npm test -- --run`、`npm run typecheck`、`npm run compile`。
