# 并发执行命令 + 展示输入输出 — 实施计划

## 目标

1. `runCommand` 工具支持并发执行多条命令（像 Claude 一样一次调用多个命令）。
2. 每条命令仍逐条弹窗确认（用户已选择保留逐条确认）。
3. 在对话 UI 中以折叠时间线展示每次工具调用的输入（命令/查询）和输出（stdout/stderr/结果），默认可展开查看（用户已选择折叠时间线）。

## 现状分析

- 并发批处理机制已存在：[reactAgentRunner.ts:282-315](../../../src/extension/agent/reactAgentRunner.ts#L282-L315) 的 `createToolRequestBatches`/`isConcurrencySafe`，只要工具声明 `isConcurrencySafe: () => true`，连续的同类调用就会被 `Promise.all` 并发执行（`exploreCode` 已经这样用）。
- `runCommandTool.ts` 没有声明 `isConcurrencySafe`，所以命令调用永远串行，即使模型一次发出多个 `runCommand` 请求。
- 每次 `runCommand` 调用都会 `showWarningMessage` 弹模态确认框；并发后多个确认框会同时弹出，需接受这个体验（用户已认可）。
- 工具调用的输入输出目前无展示：`agentEvent` 消息只是一句拼好的摘要文本，[App.tsx:204-206](../../../src/webview/App.tsx#L204-L206) 直接丢弃这个 case，UI 完全看不到执行细节。

## 设计

### 1. 允许 runCommand 并发

在 [runCommandTool.ts](../../../src/extension/agent/runCommandTool.ts) 的返回对象里加：

```ts
isConcurrencySafe: () => true,
```

不需要改并发调度逻辑（runner 侧已经支持），也不需要改批量确认逻辑——`Promise.all` 内每个 `invoke` 各自触发一次 `showWarningMessage`，VS Code 会按调用顺序排队弹窗，用户逐个确认，符合选择。

风险点：`terminateProcessTree` 用 `taskkill /T /F`（Windows）在多进程并发终止时是安全的（各自按 pid 操作），无需改动。

### 2. 扩展消息协议，携带结构化的工具调用信息

新增一类 `HostToWebviewMessage`，替代目前笼统的 `agentEvent` 文本日志（用于工具调用场景；`agentEvent` 继续保留给其它非工具的日志，如 `Planning step N`）：

```ts
// src/shared/messages.ts
| {
    type: "toolCallStarted";
    runId: string;
    callId: string;      // `${step}-${call}`，用于前端匹配 start/finished
    toolName: string;
    input: string;        // 人类可读的输入摘要（命令原文 / query 原文），已做敏感信息过滤
  }
| {
    type: "toolCallFinished";
    runId: string;
    callId: string;
    succeeded: boolean;
    output: string;       // 截断后的工具返回内容
  }
```

- `callId` 用 `${step}-${call}` 拼接，和现有日志里的 `(step ${step}, call ${call})` 对应，保证前端能把 start/finished 一一配对，即使并发。
- `input`：对 `runCommand` 直接是 `command`（cwd 附加显示）；对 `exploreCode` 复用已有的 `getExploreCodeQueryPreview`（已经做了敏感路径/密钥过滤）；其它工具用 `JSON.stringify(input)` 兜底，长度截断。
- `output`：直接用工具返回的 `content`，做长度截断（比如 2000 字符），避免大输出撑爆消息通道和 UI。

### 3. reactAgentRunner 改造

在 [reactAgentRunner.ts:163-245](../../../src/extension/agent/reactAgentRunner.ts#L163-L245) 的批处理循环里：

- 把现有的针对 `exploreCode` 特判的 `agentEvent` 换成通用的 `toolCallStarted`/`toolCallFinished`，覆盖所有工具（不仅 exploreCode）。
- 保留 "重复调用" 和 "连续失败熔断" 的 `agentEvent`（非工具调用范畴的日志，仍走旧字段）。
- 输入摘要函数从 `getExploreCodeQueryPreview` 泛化成 `getToolInputPreview(toolName, input)`，按工具名分支处理（`runCommand` → 显示 `command`；`exploreCode` → 复用现有过滤逻辑；默认 → JSON 截断）。

需要更新的测试：[reactAgentRunner.test.ts](../../../test/reactAgentRunner.test.ts) 中所有断言 `agentEvent`/`Running tool` 文案的用例（约 8 处），改为断言新的 `toolCallStarted`/`toolCallFinished` 结构。

### 4. Webview 状态与渲染

在 [App.tsx](../../../src/webview/App.tsx) 的 `AssistantTurn` 类型上新增：

```ts
type ToolCallEntry = {
  callId: string;
  toolName: string;
  input: string;
  output?: string;
  status: "running" | "succeeded" | "failed";
};

type AssistantTurn = {
  ...
  toolCalls: ToolCallEntry[];
};
```

- `case "toolCallStarted"`: 往当前 runId 对应 turn 的 `toolCalls` 数组 append 一条 `status: "running"` 的记录。
- `case "toolCallFinished"`: 按 `callId` 查找并更新为 `succeeded`/`failed` + `output`。
- 渲染：在 `AssistantMessage` 组件里，"思考过程" `<details>` 折叠区旁边新增一个"工具调用"折叠时间线区块（同样默认展开/结束后折叠，复用现有 `isProcessOpen` 的交互模式），每条记录显示：
  - 工具名 + 输入（一行）
  - 状态图标（运行中 spinner / ✓ / ✗）
  - 输出内容（可再嵌一层 `<details>`，避免长输出撑满页面）

命名沿用现有中文 UI 习惯（"思考过程"），这块可以叫"工具调用"。

### 5. 测试

- `reactAgentRunner.test.ts`：更新现有 `agentEvent` 断言为 `toolCallStarted`/`toolCallFinished`；新增一个用例验证 `runCommand` 声明 `isConcurrencySafe` 后两条命令被 `Promise.all` 并发调用（类似已有的 "ten same-name safe tool requests" 用例）。
- `runCommandTool.test.ts`：新增用例验证 `isConcurrencySafe()` 返回 `true`。
- `App.test.tsx`：新增/更新用例验证 `toolCallStarted`/`toolCallFinished` 渲染出工具名、输入、输出，且失败态和成功态图标区分。

## 影响范围

- `src/shared/messages.ts` — 新增两个消息类型
- `src/extension/agent/reactAgentRunner.ts` — 批处理循环改造
- `src/extension/agent/runCommandTool.ts` — 加 `isConcurrencySafe`
- `src/webview/App.tsx` — 状态与渲染
- `test/reactAgentRunner.test.ts`、`test/runCommandTool.test.ts`、`test/App.test.tsx` — 对应测试更新

不涉及 `workflowTools.ts` / workflow 子代理路径（那是独立的 orchestration 机制，不在本次范围内）。
