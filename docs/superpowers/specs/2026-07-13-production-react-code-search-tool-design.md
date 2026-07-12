# 生产 ReAct 与代码搜索工具设计

> 状态：实现完成，自动化验证通过；真实 DeepSeek 验证等待调试 profile 配置 API key。
>
> 前置规格：`docs/superpowers/specs/2026-07-09-react-agent-runtime-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-13-production-react-code-search-tool-plan.md`
>
> 验证记录：`docs/superpowers/plans/2026-07-13-production-react-code-search-tool-verification.md`

## 背景

仓库已经实现可测试的 `createReactAgentRunner`、工具白名单和只读测试工具，但生产入口
`createConfiguredAgentRunner` 仍返回单次调用的 `createModelRunner`。当前 DeepSeek/OpenAI-compatible
客户端只处理文本、推理和 usage 增量，不发送工具定义，也不解析原生 `tool_calls`。

代码搜索目前通过 `WorkspaceIntelligence.buildCodeIntelligencePrompt(query)` 在模型调用前自动执行。
这会让每次请求都扫描并构建代码上下文，同时纯中文查询缺少英文标识符时可能没有入口节点。
生产化目标是让模型先理解用户意图，在确有需要时主动调用只读代码搜索工具，再根据 observation
继续推理并返回最终答案。

## 目标

1. 将真实 DeepSeek provider 接入现有 ReAct loop，替换其生产单轮 runner。
2. 在通用 OpenAI-compatible 边界支持原生 `tools`、流式 `tool_calls` 和完整工具消息历史。
3. 将现有代码搜索包装为只读 `exploreCode` 工具，由模型按需调用。
4. 保持运行时上下文、取消、步数限制、工具白名单和现有 Webview 消息兼容。
5. 用真实中文问题验证“模型规划英文查询 -> AST/代码搜索 -> observation -> final”完整路径。

## 非目标

1. 不增加 shell、文件写入、Git、浏览器或任意命令执行工具。
2. 不恢复 `future/chunk-snapshot-extension` 中的分块、Snapshot、FTS 或向量功能。
3. 不实现通用工作流引擎、checkpoint、恢复、并行 agent 或长期记忆。
4. 不展示原始 reasoning 内容，也不把工具参数或源码写入普通日志。
5. 不为 DeepSeek 复制一套独立 HTTP/SSE 客户端。

## 总体架构

```text
Webview startTask
  -> createConfiguredAgentRunner
  -> collect runtime context
  -> create DeepSeek ModelProvider
  -> createOpenAiReactModelTurn(provider, tool definitions, system prompt)
  -> createReactAgentRunner
       model turn
       -> final -------------------------------> Webview
       -> tool_calls
            -> ToolRegistry
            -> exploreCode(query)
            -> WorkspaceIntelligence.buildCodeIntelligencePrompt(query)
            -> tool observation
            -> next model turn
```

生产入口只保留一个代码搜索路径。接入 ReAct 后，不再在 `systemPromptProvider` 中预先调用
`buildCodeIntelligencePrompt(request.task)`；运行时上下文仍作为初始 system message 提供。

## 模块职责

### Provider 协议

`src/extension/model/types.ts` 负责 provider-neutral wire DTO：

- `ModelToolDefinition`：工具名、说明和 JSON Schema 参数。
- `ModelToolCall`：完整的工具调用 ID、名称和参数字符串。
- `ModelMessage`：支持 system/user/assistant 文本、assistant tool calls 和 tool result。
- `ModelRequest`：增加可选 `tools` 与 `toolChoice`。
- `ModelStreamEvent`：增加 `toolCallDelta` 与 `finishReason`。

现有无工具请求保持兼容；`tools` 缺失时请求体与当前单轮路径等价。

### OpenAI-compatible SSE

`src/extension/model/openAiCompatibleClient.ts` 继续拥有 HTTP、SSE、错误映射和流事件解析。
它必须：

1. 仅在请求提供工具时发送 `tools` 和 `tool_choice`。
2. 解析 `choices[].delta.tool_calls[]`。
3. 为每个分片保留 tool call 的 `index`、`id`、函数名和 arguments 片段。
4. 发出原始、有序的 `toolCallDelta`，不在客户端层聚合或解析 arguments JSON。
5. 保留 `finish_reason`，供上层验证文本结束与工具调用结束的一致性。

同一 index 出现冲突 ID、缺失函数名或流结束后仍不完整时必须失败，不猜测或修补参数。

### React model turn adapter

新增独立适配器 `src/extension/agent/openAiReactModelTurn.ts`。它负责：

- 把 `ReactAgentMessage` 转成 provider `ModelMessage`。
- 每轮传入同一组工具定义和 system prompt。
- 收集正文与 tool call delta。
- 对完整 arguments 执行 `JSON.parse`。
- 无工具调用且有正文时返回 `{ kind: "final" }`。
- 有工具调用时返回 `{ kind: "toolRequests" }`。
- 同轮既有非空正文又有工具调用时，以工具调用为准，不把中间正文展示为最终答案。
- 空响应、无效 JSON、重复 request ID 或协议矛盾时抛出受控错误。

## ReAct 消息历史

现有 `ReactAgentMessage` 只保存 tool observation，缺少模型发出的 assistant tool-call 消息。
必须扩展为完整历史：

```text
system
user
assistant(tool_calls=[call_1])
tool(tool_call_id=call_1, name=exploreCode, content=...)
assistant(final text)
```

`ReactModelTurnResult.toolRequests` 必须同时携带解析后的 `requests` 和下一轮原样重放所需的
`assistantMessage`。每个 request 保存原始 arguments 字符串及解析后的 `input`。runner 在执行任何
工具前先追加该 assistant 消息，再按请求顺序追加 tool result；多个工具首版串行执行，保证消息顺序确定。

`ReactAgentTool` 增加 `description` 和 `inputSchema`，provider 工具定义从同一个工具对象生成，避免模型
看到的 schema 与本地校验规则分叉。

## exploreCode 工具

工具定义：

```ts
type ExploreCodeInput = {
  query: string;
};
```

JSON Schema 只允许一个必填字符串字段 `query`，拒绝额外字段。工具实现注入现有
`WorkspaceIntelligence`，调用：

```ts
workspaceIntelligence.buildCodeIntelligencePrompt(query)
```

行为约束：

1. `query` 去除首尾空白后必须非空，UTF-16 长度不得超过 1,000；超限作为参数错误拒绝执行。
2. 返回现有预算层生成的有界文本，不读取敏感路径，不增加完整图或完整源码接口。
3. 空结果返回明确 observation：未命中代码上下文。
4. 搜索异常返回不含绝对路径、密钥和堆栈的失败 observation，让模型仍可生成受限回答。
5. 工具必须响应 `AbortSignal`；取消后不得继续发送 observation 或模型请求。

首版默认工具集合只包含 `exploreCode`。`echoObservation` 仅保留在测试显式注入中，不进入生产工具定义。

## System Prompt

生产 ReAct system prompt 包含：

- 当前有界运行时上下文。
- 何时调用 `exploreCode`：需要仓库实现、位置、调用链或项目事实时。
- 如何构造查询：优先英文标识符、文件名、技术概念和关系词；纯中文问题先改写为代码检索词。
- 工具无命中时不得把通用知识伪装为仓库事实。
- 已有足够 observation 时返回 final，不重复调用相同查询。

不把用户问题预先展开为完整代码上下文，避免无条件索引成本和重复搜索。

## 生产接线

`createConfiguredAgentRunner` 的真实 provider 路径改为：

1. 读取现有模型配置和 SecretStorage key。
2. 创建并复用传入的 `WorkspaceIntelligence`。
3. 收集本次 run 的运行时上下文。
4. 创建 DeepSeek `ModelProvider`。
5. 创建 `exploreCode` 工具与 provider tool definitions。
6. 创建 React model turn adapter。
7. 返回 `createReactAgentRunner`。

fake provider 保持现有 `fakeAgentRunner`，用于无密钥开发和 UI 测试。生产不增加模式开关；真实 provider
默认走 ReAct，以免维护两条行为不同的真实聊天路径。

## 退出、取消与失败

保留现有默认值：`maxSteps = 4`、`maxToolRequestsPerStep = 3`。

- 模型返回 final：输出 `assistantDelta` 和 `runFinished`。
- 模型请求工具：执行后进入下一步。
- 达到最大步数：`runFailed`，说明达到 ReAct 上限。
- 单步工具数超限、未知工具、协议无效：`runFailed`。
- 代码搜索自身失败：作为 tool observation 返回，不直接终止 run。
- 用户新建任务、Webview 关闭或请求取消：静默停止后续模型和工具输出。

首版不增加自动重试。HTTP 429/5xx 沿用 provider 错误，避免在 ReAct loop 内形成隐式请求放大。

## 安全与资源边界

1. 工具注册表是唯一执行入口，模型返回的名称不能动态映射到任意函数。
2. `exploreCode` 继续复用现有敏感路径过滤和字符预算。
3. 工具参数、源码 observation、Authorization header 和 API key 不写日志。
4. 单次 run 最多 4 次模型调用、每步最多 3 个工具请求。
5. 工具结果只进入对应 run 的内存消息历史，run 结束后释放；本规格不持久化会话。

## 测试与验收

### 单元与集成测试

1. 请求体包含合法 OpenAI-compatible tools schema。
2. SSE 中分片的 tool ID、名称和 arguments 能按 index 正确聚合。
3. 多工具调用保持顺序，usage 和 reasoning 事件不破坏工具解析。
4. adapter 正确区分 final 与 toolRequests，并拒绝非法 JSON、重复 ID 和空响应。
5. runner 历史严格包含 assistant tool call，再包含同 ID 的 tool result。
6. `exploreCode` 校验输入、返回有界结果、处理空命中、异常和取消。
7. `createConfiguredAgentRunner` 的 DeepSeek 路径实际返回 ReAct runner，fake 路径不变。
8. 旧单轮 provider 测试、代码智能测试和 Webview 消息测试继续通过。

### 真实用户路径

在唯一的 LoopAgent Extension Development Host 中验证：

```text
用户：谁负责把代码上下文加入模型请求？
模型 tool call：exploreCode({ query: "providerRegistry buildCodeIntelligencePrompt system prompt" })
工具：返回 providerRegistry.ts、createConfiguredAgentRunner 和相关调用链
模型：基于 observation 输出中文最终答案
```

验收记录必须证明：

- 至少发生一次原生 `tool_calls`，不是预注入代码上下文或约定 JSON。
- 工具查询包含可检索的英文符号或概念。
- 最终回答引用真实文件/符号，并与工具 observation 一致。
- run 正常结束，没有 `runFailed`、重复搜索或额外调试窗口。
- API key、完整请求正文和源码 observation 未进入日志或文档。

## 交付边界

本规格完成后，真实 DeepSeek 请求默认通过 ReAct loop，并可按需调用唯一的只读 `exploreCode`
工具。它解决生产工具调用和中文查询改写入口，但不承诺持久化索引、向量召回、文件修改工具或任务恢复；
这些能力必须独立设计和验收。
