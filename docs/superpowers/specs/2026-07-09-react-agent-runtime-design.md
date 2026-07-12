# ReAct Agent Runtime 状态机设计

> 状态：最小状态机已实现；真实 provider、原生 tool call 和代码搜索工具的生产接入由
> `docs/superpowers/specs/2026-07-13-production-react-code-search-tool-design.md` 继续定义。

## 背景

LoopAgent 目前已经具备 React Webview、模型选择、DeepSeek provider、`thinking` 信号展示、`CodeRuntimeContext` 和 `WorkspaceIntelligence` 注入能力。当前 `src/extension/model/modelRunner.ts` 仍是一次性模型流式调用：它把用户任务和系统上下文发给 provider，然后把 `contentDelta`、`reasoningDelta` 转成 Webview 消息。

ReAct runtime 的目标不是替换 React UI，也不是把模型调用写进 Webview，而是在 Extension Host 侧新增一个可测试的 agent runner：它复用现有 `AgentRunner` 接口，把一次用户任务拆成“模型决策 -> 工具执行 -> observation 回填 -> 再次模型决策”的有限状态机。

## 目标

1. 新增最小 ReAct runner，实现 `AgentRunner.run(request)`。
2. 让 runner 能处理三类模型回合结果：
   - 直接最终回答。
   - 请求一个或多个工具。
   - 无效工具请求或超出步数后的失败。
3. 新增只读工具注册表，第一轮只开放安全、可测试的工具执行入口。
4. 保持 Webview 协议兼容：第一轮优先复用 `assistantThinking`、`assistantDelta`、`agentEvent`、`runFinished`、`runFailed`。
5. 保持现有 chat runner 默认行为不变，ReAct runtime 作为可单独测试和后续接入的模块。

## 非目标

1. 不在第一轮开放 shell、写文件、自动补丁或 Git 操作。
2. 不在第一轮实现完整 OpenAI tool-call streaming 解析。
3. 不把模型原始 CoT 当普通回答展示。
4. 不把 ReAct 状态机放进 `src/webview/App.tsx`。
5. 不改变现有 DeepSeek 单轮聊天路径的默认行为。

## 架构

新增模块位于 `src/extension/agent/`：

- `reactAgentRunner.ts`：状态机主循环，实现 `AgentRunner`。
- `reactTypes.ts`：ReAct 内部消息、工具请求、模型回合结果和配置类型。
- `toolRegistry.ts`：工具白名单、参数校验、工具执行、异常转 observation。
- `tools.ts`：第一轮内置工具定义。

第一轮不直接依赖 provider 的原生 tool call，而是通过注入的 `modelTurn` 函数得到结构化结果。这样可以先用单元测试验证 runtime 行为，再在后续接入 OpenAI-compatible tool call 或 JSON 指令适配器。

```text
Webview startTask
  -> extension.ts
  -> createConfiguredAgentRunner(...)
  -> AgentRunner.run(request)
  -> ReAct runner
       preparingContext
       modelTurn
       toolDispatch
       toolRunning
       observationAppended
       modelTurn
       finalizing
  -> HostToWebviewMessage
  -> React Webview
```

## 状态机

状态集合：

- `preparingContext`：构造初始 system/user 消息，发送过程事件。
- `modelTurn`：调用模型回合函数，得到最终回答或工具请求。
- `toolDispatch`：校验工具名、参数、最大工具数量。
- `toolRunning`：执行工具，支持 `AbortSignal`。
- `observationAppended`：把工具 observation 追加回内部对话。
- `finalizing`：输出最终回答和 `runFinished`。
- `failed`：输出 `runFailed`。
- `cancelled`：取消后停止输出。

状态迁移：

```text
preparingContext -> modelTurn
modelTurn -> finalizing
modelTurn -> toolDispatch
toolDispatch -> toolRunning
toolRunning -> observationAppended
observationAppended -> modelTurn
modelTurn -> failed
toolDispatch -> failed
toolRunning -> failed
任意状态 -> cancelled
```

## 内部类型

```ts
export type ReactAgentToolRequest = {
  id: string;
  name: string;
  input: unknown;
};

export type ReactModelTurnResult =
  | { kind: "final"; content: string }
  | { kind: "toolRequests"; requests: ReactAgentToolRequest[] };

export type ReactModelTurn = (input: {
  messages: ReactAgentMessage[];
  signal: AbortSignal;
}) => Promise<ReactModelTurnResult>;
```

`ReactAgentMessage` 使用 runtime 内部格式，不直接复用 provider 的 `ModelMessage`。工具 observation 在内部表示为 `role: "tool"` 消息，避免运行元数据和 provider wire format 过早耦合。

## 工具边界

工具注册表只负责确定性执行，不负责模型推理：

- `has(name)`：判断工具是否存在。
- `invoke(request, signal)`：执行工具并返回 observation。
- 未知工具返回失败 observation 或抛出受控错误，由 runner 转成 `runFailed`。
- 工具返回内容必须是字符串，后续可增加结构化 preview。

第一轮内置工具保持只读：

- `echoObservation`：测试和本地验证用，把输入转成 observation。
- 后续可接入 `searchWorkspace`、`readWorkspaceFile`、`exploreCode`。

## Webview 消息

第一轮复用现有消息协议：

- `assistantThinking`：展示状态机阶段，例如 `Planning step 1`、`Received final answer`。
- `agentEvent`：展示工具执行事件，例如 `Running tool echoObservation`。
- `assistantDelta`：输出最终回答。
- `runFinished`：正常结束。
- `runFailed`：失败结束。

后续如果 UI 需要结构化工具卡片，再扩展 `toolStarted`、`toolFinished`，不影响第一轮 runtime。

## 安全与限制

1. `maxSteps` 默认 4，防止模型循环调用工具。
2. 每轮最多允许有限数量工具请求，第一轮默认 3。
3. 未知工具直接失败，不让模型自由构造执行入口。
4. 工具必须接收 `AbortSignal`，取消后不继续发消息。
5. 第一轮不执行写操作，避免绕过用户确认。

## 验证方式

单元测试覆盖：

1. 模型直接返回 final 时，runner 输出 `assistantDelta` 和 `runFinished`。
2. 模型请求工具后，runner 执行工具、追加 observation，并在下一轮输出 final。
3. 未知工具请求转成 `runFailed`。
4. 超过 `maxSteps` 后转成 `runFailed`。
5. 已取消的 run 不继续输出。

项目级验证：

- `npm test -- test/reactAgentRunner.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run compile`

## 后续接入点

1. 在 `providerRegistry.ts` 增加 `loopagent.agent.mode` 后，可把 ReAct runner 接入真实模型 provider。
2. 在 `openAiCompatibleClient.ts` 解析原生 tool call delta 后，可把 provider 事件转成 `ReactModelTurnResult`。
3. 在工具层接入 `WorkspaceIntelligence.exploreCode(task)`，让模型能主动检索代码图上下文。
4. 写操作工具需要单独设计审批、diff preview、回滚和验证流程。
