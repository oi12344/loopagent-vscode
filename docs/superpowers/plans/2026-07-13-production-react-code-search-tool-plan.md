# 生产 ReAct 与代码搜索工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把真实 DeepSeek 请求接入 ReAct loop，并以原生 OpenAI-compatible `tool_calls` 按需调用只读 `exploreCode`。

**Architecture:** 通用 provider 层发送工具定义并映射流式 tool-call delta；独立 adapter 聚合回合结果；ReAct runner 保存完整 assistant/tool 历史；生产 registry 注入运行时 system prompt 和现有 WorkspaceIntelligence 搜索工具。fake provider 与未来分块分支保持不变。

**Tech Stack:** TypeScript、DeepSeek/OpenAI-compatible Chat Completions SSE、VS Code Extension API、Vitest、现有 ReAct runtime 与 WorkspaceIntelligence。

---

## 文件职责

- `model/types.ts`：provider-neutral 工具、消息、请求和流事件 DTO。
- `model/openAiCompatibleClient.ts`：请求体与 SSE tool-call delta 映射。
- `agent/openAiReactModelTurn.ts`：聚合一轮模型流并转换为 ReAct 结果。
- `agent/reactTypes.ts`、`reactAgentRunner.ts`：完整 assistant/tool 历史与懒加载 system prompt。
- `agent/exploreCodeTool.ts`：只读代码搜索工具及输入校验。
- `model/providerRegistry.ts`：真实 provider 的生产 ReAct 接线。

## Task 1：扩展 OpenAI-compatible 工具调用协议

**Files:**
- Modify: `src/extension/model/types.ts`
- Modify: `src/extension/model/openAiCompatibleClient.ts`
- Modify: `test/openAiCompatibleClient.test.ts`

- [ ] **Step 1：写请求体和分片 tool call 失败测试**

新增用例：请求带 `exploreCode` schema；SSE 用两个 chunk 拼出 `call_1`、`exploreCode` 和 `{"query":"provider registry"}`，最后返回 `finish_reason: "tool_calls"`。断言事件包含：

```ts
{ type: "toolCallDelta", index: 0, id: "call_1", name: "exploreCode", argumentsDelta: "{\"query\":" }
{ type: "toolCallDelta", index: 0, argumentsDelta: "\"provider registry\"}" }
{ type: "finishReason", reason: "tool_calls" }
```

- [ ] **Step 2：运行 RED**

Run: `npm test -- test/openAiCompatibleClient.test.ts`

Expected: FAIL，`ModelRequest` 不接受 tools，客户端不发送 schema 且不产生 tool-call 事件。

- [ ] **Step 3：实现最小 wire DTO 与事件映射**

在 `types.ts` 增加：

```ts
export type ModelToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ModelToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
```

把 `ModelMessage` 改为支持 assistant `toolCalls` 和 tool `toolCallId` 的判别联合；给 `ModelRequest` 增加可选 `tools`、`toolChoice: "auto"`；给 `ModelStreamEvent` 增加 `toolCallDelta` 与 `finishReason`。客户端把内部 camelCase 消息显式序列化为 OpenAI wire 字段 `tool_calls`、`tool_call_id`，仅映射每个 delta 的 index/片段，不聚合、不解析 JSON；无 tools 时不发送相关字段。

- [ ] **Step 4：运行 GREEN 与兼容回归**

Run: `npm test -- test/openAiCompatibleClient.test.ts test/modelProvider.test.ts test/modelRunnerContext.test.ts`

Expected: 全部通过；原文本流请求体保持不变。

- [ ] **Step 5：提交**

```powershell
git add src/extension/model/types.ts src/extension/model/openAiCompatibleClient.ts test/openAiCompatibleClient.test.ts
git diff --cached --check
git commit -m "feat(agent): stream native tool calls"
```

## Task 2：实现 model-turn adapter 和完整 ReAct 历史

**Files:**
- Create: `src/extension/agent/openAiReactModelTurn.ts`
- Create: `test/openAiReactModelTurn.test.ts`
- Modify: `src/extension/agent/reactTypes.ts`
- Modify: `src/extension/agent/reactAgentRunner.ts`
- Modify: `test/reactAgentRunner.test.ts`

- [ ] **Step 1：写 adapter 聚合与历史 RED 测试**

测试 provider 依次产生两个 `toolCallDelta` 和 `finishReason`，断言 adapter 返回：

```ts
{
  kind: "toolRequests",
  assistantMessage: { role: "assistant", toolCalls: [expect.objectContaining({ id: "call_1" })] },
  requests: [{ id: "call_1", name: "exploreCode", rawArguments: "{\"query\":\"provider registry\"}", input: { query: "provider registry" } }]
}
```

runner 第二轮消息必须先包含 assistant toolCalls，再包含同 ID 的 tool observation。另测文本 final、无效 JSON、重复 ID、空响应，以及 system prompt provider 失败时仍继续。

- [ ] **Step 2：运行 RED**

Run: `npm test -- test/openAiReactModelTurn.test.ts test/reactAgentRunner.test.ts`

Expected: FAIL，adapter、assistant tool-call 历史和 system provider 尚不存在。

- [ ] **Step 3：实现 adapter、类型与 runner 历史**

`ReactAgentTool` 增加必填 `description`、`inputSchema`；`ReactAgentToolRequest` 增加 `rawArguments`；`toolRequests` 结果增加 `assistantMessage`。adapter 按 index 聚合片段、校验 finish reason、解析 JSON，并从工具对象生成 provider schema。

给 runner 增加：

```ts
systemPromptProvider?: (request: AgentRunRequest) => string | Promise<string>;
```

runner 在 user 前追加非空 system message；provider 失败时继续无运行时上下文。工具执行前追加 `assistantMessage`，多个工具按请求顺序串行执行。

- [ ] **Step 4：运行 GREEN**

Run: `npm test -- test/openAiReactModelTurn.test.ts test/reactAgentRunner.test.ts`

Expected: 全部通过，现有 maxSteps、未知工具和取消行为不变。

- [ ] **Step 5：提交**

```powershell
git add src/extension/agent/openAiReactModelTurn.ts src/extension/agent/reactTypes.ts src/extension/agent/reactAgentRunner.ts test/openAiReactModelTurn.test.ts test/reactAgentRunner.test.ts
git diff --cached --check
git commit -m "feat(agent): adapt model turns for react"
```

## Task 3：把现有代码搜索包装为 exploreCode

**Files:**
- Create: `src/extension/agent/exploreCodeTool.ts`
- Create: `test/exploreCodeTool.test.ts`
- Modify: `src/extension/agent/tools.ts`

- [ ] **Step 1：写输入、安全和 observation RED 测试**

覆盖：合法 query 调用 `buildCodeIntelligencePrompt("provider registry")`；空白、额外字段和超过 1,000 字符输入被拒绝；空命中返回“未命中代码上下文”；搜索异常返回无堆栈/绝对路径的失败 observation；调用前或完成后取消时抛出 `AbortError`。

- [ ] **Step 2：运行 RED**

Run: `npm test -- test/exploreCodeTool.test.ts`

Expected: FAIL，`createExploreCodeTool` 不存在。

- [ ] **Step 3：实现只读工具**

```ts
export function createExploreCodeTool(workspaceIntelligence: WorkspaceIntelligence): ReactAgentTool;
```

工具名固定为 `exploreCode`，schema 使用 `additionalProperties: false`。运行时独立校验对象形状；只捕获搜索错误并返回安全 observation，参数错误和取消继续抛出。`createDefaultReactTools()` 不再默认暴露 `echoObservation`，测试需要时显式注入。

- [ ] **Step 4：运行 GREEN 与搜索回归**

Run: `npm test -- test/exploreCodeTool.test.ts test/intelligence/workspaceIntelligence.test.ts test/reactAgentRunner.test.ts`

Expected: 全部通过，敏感文件仍不进入搜索结果。

- [ ] **Step 5：提交**

```powershell
git add src/extension/agent/exploreCodeTool.ts src/extension/agent/tools.ts test/exploreCodeTool.test.ts test/reactAgentRunner.test.ts
git diff --cached --check
git commit -m "feat(agent): expose code exploration tool"
```

## Task 4：接入真实生产 runner

**Files:**
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `test/providerRegistryCodeContext.test.ts`
- Modify: `test/extensionWorkspaceIntelligence.test.ts`

- [ ] **Step 1：写两轮生产链路 RED 测试**

mock provider 第一轮返回原生 `exploreCode` tool-call delta，第二轮读取 tool message 并返回中文 final。断言：生产 runner 发出 `Running tool exploreCode`；`buildCodeIntelligencePrompt` 只以模型生成的英文 query 调用一次；第二轮消息包含 assistant tool call 和 observation；初始 system 只含 ReAct 指令与 runtime context，不再预注入代码搜索结果。

- [ ] **Step 2：运行 RED**

Run: `npm test -- test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts`

Expected: FAIL，registry 仍返回 `createModelRunner` 并预先执行搜索。

- [ ] **Step 3：实现生产接线**

真实 provider 路径创建 `exploreCode`、`createOpenAiReactModelTurn` 和 `createReactAgentRunner`。`systemPromptProvider` 返回固定 ReAct 工具指导加 `renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext())`；运行时上下文失败时 adapter 仍可调用模型。fake 路径保持原样。

- [ ] **Step 4：运行生产集成 GREEN**

Run: `npm test -- test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts test/reactAgentRunner.test.ts test/openAiReactModelTurn.test.ts`

Expected: 全部通过，搜索由模型 tool call 触发而不是 request.task 预触发。

- [ ] **Step 5：提交**

```powershell
git add src/extension/model/providerRegistry.ts test/providerRegistryCodeContext.test.ts test/extensionWorkspaceIntelligence.test.ts
git diff --cached --check
git commit -m "feat(agent): enable production react code search"
```

## Task 5：完整验证、真实宿主和文档收口

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-production-react-code-search-tool-design.md`
- Create: `docs/superpowers/plans/2026-07-13-production-react-code-search-tool-verification.md`

- [ ] **Step 1：运行阶段整体门禁**

```powershell
npm test -- --run
npm run typecheck
npm run compile
git diff --check
```

Expected: 全部退出 0；没有临时调试文件或新增敏感信息。

- [ ] **Step 2：在唯一调试窗口验证真实 DeepSeek**

先使用 `testing-vscode-extension-e2e` 技能，再运行 `npm run debug:vscode`。复用固定调试窗口，执行 `LoopAgent: Open Panel`，提问：`谁负责把代码上下文加入模型请求？`。验证原生 `tool_calls -> exploreCode -> tool result -> final`，不得打开第二个调试窗口。

- [ ] **Step 3：记录中文验证结果并更新规格状态**

验证文档记录版本、问题、工具名、工具 query、命中文件/符号、最终状态和测试统计；密钥、完整源码 observation 和请求正文写为 `[REDACTED_SECRET]` 或不记录。把规格状态改为“已实现并验证”，如实记录实际偏差。

- [ ] **Step 4：复验文档和清理状态**

Run: `git diff --check; git status --short`

Expected: 只包含预期文档；无日志、截图临时目录、密钥、废弃 TODO 或调试代码。

- [ ] **Step 5：提交**

```powershell
git add docs/superpowers/specs/2026-07-13-production-react-code-search-tool-design.md docs/superpowers/plans/2026-07-13-production-react-code-search-tool-verification.md
git diff --cached --check
git commit -m "docs: verify production react code search"
```
