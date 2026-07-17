# 模型推理与右侧对话实施计划

> **面向 Agent 执行者：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐项执行；所有步骤使用复选框追踪。

**目标：** 将 provider 返回的 reasoning 流原文展示为唯一的 Process 内容，并把用户请求明确显示为右侧对话气泡。

**架构：** 新增一个窄的 Host 到 Webview 推理分段事件。modelRunner 只转发 provider 已返回的 reasoningDelta；App 将该事件累加到助手消息独立的 reasoning 字段，通用 thinking 与工具事件只保留运行状态。样式通过新增的用户气泡类与 reasoning 文本类实现，不使用 JavaScript 布局。

**技术栈：** TypeScript、React 19、CSS、Vitest、Testing Library、VS Code Webview。

## 全局约束

- 只修改 src/shared/messages.ts、src/extension/model/modelRunner.ts、src/webview/App.tsx、src/webview/styles.css、test/modelRunnerContext.test.ts、test/modelProvider.test.ts、test/App.test.tsx 与本计划的实施记录。
- 不修改 WebviewToHostMessage、模型请求、工具执行、Extension Host、模型配置或 ReactAgentRunner。
- 只显示 provider 已返回的 reasoningDelta 字符串；不生成、总结、推断或补全隐藏思考。
- assistantThinking 与 agentEvent 不得作为 Process 内容；没有 reasoning 流时不显示空 Process。
- 不新增依赖、图标库、图片、渐变、硬编码主题色、持久化、工具面板或任务历史。
- 用户消息在宽侧栏右对齐且不超过内容区 80%；最大 340px 侧栏中不产生水平溢出。
- 仅使用一个 Extension Development Host，并通过 npm run debug:vscode 启动。

---

## 文件范围

- src/shared/messages.ts：新增 assistantReasoningDelta Host 消息成员。
- src/extension/model/modelRunner.ts：逐段转发 ModelStreamEvent.reasoningDelta。
- test/modelRunnerContext.test.ts：验证原始 reasoning 分段的 Host 映射。
- test/modelProvider.test.ts：更新既有 provider 流映射的推理事件断言。
- src/webview/App.tsx：保存并显示 reasoning，忽略通用过程日志，添加右侧用户气泡类。
- src/webview/styles.css：模型推理文本与右侧气泡的主题感知样式。
- test/App.test.tsx：验证 reasoning 显示边界、完成折叠和用户气泡类。
- docs/superpowers/plans/2026-07-17-model-reasoning-and-right-alignment-plan.md：记录实际验证结果。

### Task 1：建立模型 reasoning 事件契约

**Files：**

- Modify: src/shared/messages.ts
- Modify: src/extension/model/modelRunner.ts
- Modify: test/modelRunnerContext.test.ts
- Modify: test/modelProvider.test.ts

**Consumes：** ModelStreamEvent.reasoningDelta 的 content 字段，以及 HostToWebviewMessage 联合类型。

**Produces：** { type: "assistantReasoningDelta"; runId: string; content: string }，供 Webview 逐段追加且保留 provider 原文。

- [ ] **步骤 1：写入失败的 reasoning 映射测试**

在 test/modelRunnerContext.test.ts 新增 provider 推理流用例：

~~~ts
it("forwards provider reasoning deltas without replacing their content", async () => {
  const provider: ModelProvider = {
    id: "test",
    displayName: "Test Model",
    stream: async function* () {
      yield { type: "reasoningDelta", content: "Inspecting the active file. " };
      yield { type: "reasoningDelta", content: "Checking related callers." };
      yield { type: "contentDelta", content: "Done." };
    },
  };

  const hostMessages = await collectHostMessages(createModelRunner({ provider }), "Inspect code");

  expect(hostMessages).toContainEqual({
    type: "assistantReasoningDelta",
    runId: "run-1",
    content: "Inspecting the active file. ",
  });
  expect(hostMessages).toContainEqual({
    type: "assistantReasoningDelta",
    runId: "run-1",
    content: "Checking related callers.",
  });
  expect(hostMessages.some((message) => (
    message.type === "assistantThinking" && message.message === "Received model reasoning signal"
  ))).toBe(false);
});
~~~

将 test/modelProvider.test.ts 既有 `turns provider stream events into structured assistant chat messages` 的期望消息替换为：

~~~ts
{ type: "assistantReasoningDelta", runId: "run-1", content: "private raw reasoning" },
~~~

并将该用例末尾的否定断言替换为：

~~~ts
expect(hostMessages).toContainEqual({
  type: "assistantReasoningDelta",
  runId: "run-1",
  content: "private raw reasoning",
});
~~~

- [ ] **步骤 2：运行定向测试确认红灯**

~~~powershell
npm test -- --run test/modelRunnerContext.test.ts test/modelProvider.test.ts
~~~

预期：测试失败，因为 Host 消息联合类型和 modelRunner 尚未产生 assistantReasoningDelta；既有 provider 流断言仍期待旧的 Received model reasoning signal。

- [ ] **步骤 3：添加最小消息契约与转发**

在 src/shared/messages.ts 的 HostToWebviewMessage 联合中加入：

~~~ts
| {
    type: "assistantReasoningDelta";
    runId: string;
    content: string;
  }
~~~

在 src/extension/model/modelRunner.ts 的 provider 流循环中替换现有 reasoning 信号逻辑：

~~~ts
if (event.type === "reasoningDelta") {
  yield {
    type: "assistantReasoningDelta",
    runId,
    content: event.content,
  } satisfies HostToWebviewMessage;
}
~~~

删除 reportedReasoningSignal 变量以及 Received model reasoning signal 事件；保留 Building code context 和 Calling provider 的 assistantThinking 状态事件。

- [ ] **步骤 4：运行定向测试确认绿灯并提交**

~~~powershell
npm test -- --run test/modelRunnerContext.test.ts test/modelProvider.test.ts
git add -- src/shared/messages.ts src/extension/model/modelRunner.ts test/modelRunnerContext.test.ts test/modelProvider.test.ts
git commit -m "feat(model): stream reasoning to webview"
~~~

预期：modelRunnerContext 测试全部通过，两个 reasoning 分段原样出现在 Host 消息中。

### Task 2：展示真实推理并右对齐用户气泡

**Files：**

- Modify: src/webview/App.tsx
- Modify: src/webview/styles.css
- Modify: test/App.test.tsx

**Consumes：** Task 1 的 assistantReasoningDelta 消息，以及现有 AssistantTurn 状态和 message-user 样式。

**Produces：** AssistantTurn.reasoning 字符串、只显示 reasoning 的 Process details、message-user-right 样式类。

- [ ] **步骤 1：写入失败的 Webview 行为测试**

在 test/App.test.tsx 新增：

~~~tsx
it("shows only provider reasoning in Process and right-aligns user tasks", () => {
  render(<App />);

  postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
  postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
  postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Building code context" });
  postHostMessage({ type: "agentEvent", runId: "run-1", message: "Running tool exploreCode" });
  postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Inspecting the active file. " });
  postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Checking callers." });
  postHostMessage({ type: "runFinished", runId: "run-1" });

  expect(screen.getByText("Inspecting the active file. Checking callers.")).toBeInTheDocument();
  expect(screen.queryByText("Building code context")).not.toBeInTheDocument();
  expect(screen.queryByText("Running tool exploreCode")).not.toBeInTheDocument();
  expect(screen.getByText("Inspect the project").closest("article")).toHaveClass("message-user-right");
  expect(screen.getByText("Process").closest("details")).not.toHaveAttribute("open");
});
~~~

将现有 `renders assistant process and streamed answer` 用例中的两个 `assistantThinking` 事件替换为：

~~~tsx
postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Inspecting the request. " });
postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Preparing the answer." });
~~~

断言 `Inspecting the request. Preparing the answer.` 出现在 Process 中，并断言旧的 `Calling DeepSeek v4 flash` 和 `Received model reasoning signal` 不再出现。将现有 `collapses completed execution steps` 用例中的 `assistantThinking` 替换为一条 `assistantReasoningDelta`，使该用例仍验证完成后折叠。更新遗留 agentEvent 用例，使其断言通用 Agent 事件不在 Process 中显示。

- [ ] **步骤 2：运行定向测试确认红灯**

~~~powershell
npm test -- --run test/App.test.tsx
~~~

预期：测试因 assistantReasoningDelta 未被 App 处理、通用事件仍显示为 Process、用户消息缺少 message-user-right 类而失败。

- [ ] **步骤 3：在 App.tsx 实现最小状态与呈现改动**

将 AssistantTurn 中的 process 改为 reasoning，并在初始助手消息中使用空字符串：

~~~tsx
type AssistantTurn = {
  id: string;
  role: "assistant";
  runId: string;
  provider: string;
  reasoning: string;
  content: string;
  status: "thinking" | "streaming" | "done" | "error";
  error?: string;
};
~~~

在 Host 消息处理器中仅追加 provider 推理：

~~~tsx
if (hostMessage.type === "assistantReasoningDelta") {
  updateAssistantTurn(hostMessage.runId, (turn) => ({
    ...turn,
    reasoning: turn.reasoning + hostMessage.content,
    status: turn.content.length > 0 ? "streaming" : "thinking",
  }));
  return;
}
~~~

将 assistantThinking、agentEvent、runFinished 和 runFailed 的更新改为只更新 status 或 error，不再修改 reasoning。将 AssistantMessage 的 details 条件和内容改为：

~~~tsx
{turn.reasoning.length > 0 ? (
  <details className="process-details" open={isProcessOpen} onToggle={(event) => setIsProcessOpen(event.currentTarget.open)}>
    <summary>Process</summary>
    <div className="reasoning-content">{turn.reasoning}</div>
  </details>
) : null}
~~~

将 UserMessage 的 article 类名改为 message message-user message-user-right。

- [ ] **步骤 4：在 styles.css 添加右侧气泡与 reasoning 样式**

~~~css
.message-user-right {
  justify-self: end;
  margin-left: auto;
  max-width: 80%;
}

.message-user-right .message-meta {
  justify-content: flex-end;
}

.reasoning-content {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@media (max-width: 340px) {
  .message-user-right {
    max-width: 94%;
  }
}
~~~

删除 process-details 针对 ol 与 li 的旧规则；保留 details、summary、错误与回答样式。

- [ ] **步骤 5：运行定向测试确认绿灯并提交**

~~~powershell
npm test -- --run test/App.test.tsx
git add -- src/webview/App.tsx src/webview/styles.css test/App.test.tsx
git commit -m "feat(ui): show model reasoning"
~~~

预期：App 测试全部通过，Process 仅包含 provider reasoning，完成后折叠，用户消息具有右侧气泡类。

### Task 3：集中验证与交付记录

**Files：**

- Modify: docs/superpowers/plans/2026-07-17-model-reasoning-and-right-alignment-plan.md

**Consumes：** Task 1 与 Task 2 已提交的实现和测试。

**Produces：** 只记录实际验证结果的中文实施记录。

- [ ] **步骤 1：运行集中验证与清理检查**

~~~powershell
npm test
npm run typecheck
npm run compile
git diff --check
git status --short
rg -n -i "console\.log|TODO|TBD" src/shared/messages.ts src/extension/model/modelRunner.ts src/webview/App.tsx src/webview/styles.css test/modelRunnerContext.test.ts test/modelProvider.test.ts test/App.test.tsx
~~~

预期：测试、类型检查、构建和 diff 检查全部成功；rg 无匹配时退出码 1 按清理通过处理；不删除无关用户文件。

- [ ] **步骤 2：使用唯一宿主完成可视验收**

~~~powershell
npm run debug:vscode
~~~

在启动的唯一 Extension Development Host 中使用已配置且会返回 reasoningDelta 的 provider，确认 Process 仅显示 provider reasoning、用户任务气泡在右侧、完成后 Process 可手动重新展开。关闭该调试宿主后继续交付；若 provider 或 Windows 自动化不可用，只记录真实限制，不伪称通过。

- [ ] **步骤 3：写入实施结果并提交**

在本文档末尾增加 ## 实施结果，只记录实际通过的命令、可视验收结论和未完成项。然后运行：

~~~powershell
git add -- docs/superpowers/plans/2026-07-17-model-reasoning-and-right-alignment-plan.md
git commit -m "docs(ui): record reasoning verification"
~~~
