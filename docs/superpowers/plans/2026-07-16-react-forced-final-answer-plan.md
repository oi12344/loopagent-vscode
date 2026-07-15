# ReAct 强制最终回答实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 默认允许模型执行最多 3 个工具步骤，并保证随后有 1 个关闭工具的模型步骤负责综合已有证据和说明限制。

**架构：** 保留现有 ReAct 循环，在最后一次迭代向同一个 `ReactModelTurn` 传入 `toolChoice = "none"`。OpenAI-compatible adapter 原样把该值传给 provider；不增加 Judge、planner、配置项或新调度层。

**技术栈：** TypeScript、Vitest、现有 OpenAI-compatible provider、VS Code VSIX E2E。

## 全局约束

- `maxSteps` 表示可调用工具的步骤数，默认值为 3。
- 默认总模型调用最多 4 次：3 个 `auto` 步骤和 1 个 `none` 步骤。
- 模型在任一工具步骤直接回答时必须立即结束，不执行多余最终步骤。
- 最终步骤不得执行任何工具；provider 违反 `toolChoice = "none"` 时按协议错误结束。
- 单步同名工具去重、请求/结果配对、`maxToolRequestsPerStep = 3`、取消和工具异常语义保持不变。
- 不增加依赖、配置项、Judge、planner 或通用调度抽象。
- 开发、测试和提交只在 `E:\zz\loopagent-vscode\.worktrees\limit-duplicate-tool-calls` 完成。

---

### Task 1：保证工具预算后仍有最终回答

**文件：**

- 修改：`test/reactAgentRunner.test.ts`
- 修改：`test/openAiReactModelTurn.test.ts`
- 修改：`src/extension/agent/reactAgentRunner.ts`
- 修改：`src/extension/agent/reactTypes.ts`
- 修改：`src/extension/agent/openAiReactModelTurn.ts`
- 修改：`src/extension/model/types.ts`
- 更新：`docs/superpowers/plans/2026-07-16-react-forced-final-answer-plan.md`

**接口：**

- `ReactModelTurn` 新增可选输入：`toolChoice?: "auto" | "none"`。
- `ModelRequest.toolChoice` 从仅支持 `"auto"` 扩展为 `"auto" | "none"`。
- `createReactAgentRunner` 保留 `maxSteps` 选项名称，但将它解释为可调用工具的步骤数。

- [x] **步骤 1：写入失败的 Runner 行为测试**

把 `test/reactAgentRunner.test.ts` 中“达到最大 ReAct 步骤后失败”的用例替换为：

```typescript
it("forces a final answer after reaching the maximum tool steps", async () => {
  let toolTurn = 0;
  const choices: Array<"auto" | "none" | undefined> = [];
  const invoke = vi.fn(async () => "observed workspace");
  const runner = createReactAgentRunner({
    maxSteps: 2,
    tools: [
      {
        name: "echoObservation",
        description: "Echo a test observation.",
        inputSchema: { type: "string" },
        invoke,
      },
    ],
    modelTurn: async ({ toolChoice }) => {
      choices.push(toolChoice);
      if (toolChoice === "none") {
        return { kind: "final", content: "Best supported answer with limitations." };
      }
      toolTurn += 1;
      const id = `tool-${toolTurn}`;
      return {
        kind: "toolRequests",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [{ id, type: "function", function: { name: "echoObservation", arguments: '"workspace"' } }],
        },
        requests: [{ id, name: "echoObservation", rawArguments: '"workspace"', input: "workspace" }],
      };
    },
  });

  const messages = await collectRunnerMessages(runner);

  expect(choices).toEqual(["auto", "auto", "none"]);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(messages).toContainEqual({
    type: "assistantDelta",
    runId: "run-1",
    content: "Best supported answer with limitations.",
  });
  expect(messages.at(-1)).toEqual({ type: "runFinished", runId: "run-1" });
  expect(messages.some((message) => message.type === "runFailed")).toBe(false);
});
```

- [x] **步骤 2：写入失败的 adapter 契约测试**

在 `test/openAiReactModelTurn.test.ts` 新增用例，使用内联 `ModelProvider` 捕获请求：

```typescript
it("passes the requested tool choice to the provider", async () => {
  let seenToolChoice: "auto" | "none" | undefined;
  const provider: ModelProvider = {
    id: "test",
    displayName: "Test",
    async *stream(request) {
      seenToolChoice = request.toolChoice;
      yield { type: "contentDelta", content: "Final answer." } as const;
      yield { type: "finishReason", reason: "stop" } as const;
    },
  };
  const modelTurn = createOpenAiReactModelTurn({ provider, tools: [exploreCodeTool] });

  await modelTurn({
    messages: [{ role: "user", content: "Status?" }],
    signal: new AbortController().signal,
    toolChoice: "none",
  });

  expect(seenToolChoice).toBe("none");
});
```

- [x] **步骤 3：运行定向测试并确认红灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts test/openAiReactModelTurn.test.ts
```

预期：Runner 用例因收到 `[undefined, undefined]` 且仍产生 `runFailed` 而失败；adapter 用例因 provider 收到 `"auto"` 而失败。不得出现测试语法或环境错误。

- [x] **步骤 4：实现最小工具选择契约**

在 `src/extension/model/types.ts` 扩展：

```typescript
toolChoice?: "auto" | "none";
```

在 `src/extension/agent/reactTypes.ts` 的 `ReactModelTurn` 输入增加：

```typescript
toolChoice?: "auto" | "none";
```

在 `src/extension/agent/openAiReactModelTurn.ts` 使用默认值并透传：

```diff
-  return async ({ messages, signal }) => {
+  return async ({ messages, signal, toolChoice = "auto" }) => {
@@
-      toolChoice: "auto",
+      toolChoice,
```

- [x] **步骤 5：实现 3 个工具步骤和 1 个最终步骤**

在 `src/extension/agent/reactAgentRunner.ts` 把默认值改为：

```typescript
maxSteps = 3,
```

循环包含额外最终步骤，并在模型调用前计算工具选择：

```diff
-        for (let step = 1; step <= maxSteps; step++) {
+        for (let step = 1; step <= maxSteps + 1; step++) {
+          const isFinalAnswerStep = step > maxSteps;
           if (signal.aborted) {
             return;
           }
@@
-          const result = await modelTurn({ messages, signal });
+          const result = await modelTurn({
+            messages,
+            signal,
+            toolChoice: isFinalAnswerStep ? "none" : "auto",
+          });
@@
           if (result.kind === "final") {
             yield { type: "assistantDelta", runId, content: result.content } satisfies HostToWebviewMessage;
             yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
             return;
           }
+          if (isFinalAnswerStep) {
+            throw new Error("Model requested tools during the final answer step");
+          }
@@
-        yield { type: "runFailed", runId, message: `Reached max ReAct steps: ${maxSteps}` } satisfies HostToWebviewMessage;
```

删除循环后的 `Reached max ReAct steps` 失败事件；正常上限由强制最终回答收敛。

- [x] **步骤 6：运行定向测试并确认绿灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts test/openAiReactModelTurn.test.ts
```

预期：两个测试文件全部通过。

- [x] **步骤 7：执行集中验证（真实 E2E 由主代理提交后执行）**

独立运行：

```powershell
npm run typecheck
npm test
npm run compile
git diff --check
```

随后打包当前 worktree VSIX，在唯一 Extension Development Host 中运行：

```powershell
npm run test:e2e:code-exploration
```

读取 Process 状态，确认最多 3 个 `Running tool exploreCode`，随后出现第 4 个 `Planning step` 和 `Done`，且没有 `Reached max ReAct steps`。

- [x] **步骤 8：记录结果并提交**

在本文末尾追加中文实施结果，记录红灯、绿灯、全量验证、E2E 调用明细和已知边界，然后提交：

```powershell
git add -- docs/superpowers/plans/2026-07-16-react-forced-final-answer-plan.md src/extension/agent/reactAgentRunner.ts src/extension/agent/reactTypes.ts src/extension/agent/openAiReactModelTurn.ts src/extension/model/types.ts test/reactAgentRunner.test.ts test/openAiReactModelTurn.test.ts
git commit -m "fix(agent): reserve a final answer turn"
```

## 实施结果

- 红灯：`npm test -- --run test/reactAgentRunner.test.ts test/openAiReactModelTurn.test.ts` 得到 2 个失败、13 个通过。Runner 仅收到 `[undefined, undefined]` 且没有最终轮；adapter 收到固定的 `"auto"`，与预期 `"none"` 不符。
- 绿灯：同一定向命令得到 2 个测试文件、15 个测试全部通过。
- 全量测试：`npm test` 得到 50 个测试文件、276 个测试全部通过；仅有 Node SQLite experimental warning。
- 静态与构建验证：`npm run typecheck`、`npm run compile`、`git diff --check` 均以退出码 0 完成。
- E2E：按任务分工未在实现代理中运行，主代理将在提交后使用唯一 Extension Development Host 验证真实流程。
