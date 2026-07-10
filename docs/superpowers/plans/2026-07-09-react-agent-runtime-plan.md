# ReAct Agent Runtime 最小实现计划

**Goal:** 在 Extension Host 侧新增可测试的最小 ReAct agent runtime 状态机，保持现有单轮 chat runner 默认行为不变。

**Architecture:** 新增 `src/extension/agent/` 子模块，内部拆分为类型、工具注册表和 ReAct runner。runner 实现现有 `AgentRunner` 接口，通过注入的 `modelTurn` 函数驱动“模型回合 -> 工具执行 -> observation 回填 -> 最终回答”的循环，并复用现有 Webview 消息协议。第一轮只实现只读测试工具，不接入 shell、写文件或真实 provider tool-call streaming。

**Tech Stack:** TypeScript、VS Code Extension Host、Vitest、现有 `AgentRunner` / `HostToWebviewMessage` 协议。

## Task 1: 增加 ReAct runner 红灯测试

Create: `test/reactAgentRunner.test.ts`

测试行为：

```ts
it("finishes when the model returns a final answer", async () => {
  const runner = createReactAgentRunner({
    modelTurn: async () => ({ kind: "final", content: "done" }),
  });

  const messages = await collectRunnerMessages(runner, "run-1", "hello");

  expect(messages).toContainEqual({ type: "assistantDelta", runId: "run-1", content: "done" });
  expect(messages).toContainEqual({ type: "runFinished", runId: "run-1" });
});
```

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: 失败，原因是 `src/extension/agent/reactAgentRunner.ts` 尚不存在。

## Task 2: 实现最小 final-answer 路径

Create:

- `src/extension/agent/reactTypes.ts`
- `src/extension/agent/reactAgentRunner.ts`

实现：

- `createReactAgentRunner(options): AgentRunner`
- 初始 `assistantStarted`
- `Planning step 1`
- 调用 `modelTurn`
- final answer 转成 `assistantDelta`
- 结束时发送 `runFinished`

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: Task 1 测试通过。

## Task 3: 增加工具调用红灯测试

Modify: `test/reactAgentRunner.test.ts`

新增测试：

- 第一轮模型返回 `toolRequests`。
- runner 发送 `agentEvent: Running tool echoObservation`。
- 工具返回 observation。
- 第二轮模型能看到 observation 并返回 final。

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: 失败，原因是工具注册表和 observation 回填尚未实现。

## Task 4: 实现工具注册表和 observation 回填

Create:

- `src/extension/agent/toolRegistry.ts`
- `src/extension/agent/tools.ts`

Modify:

- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/agent/reactTypes.ts`

实现：

- `createToolRegistry(tools)`
- `echoObservation` 只读工具
- 工具请求校验
- observation 追加到内部消息
- 下一轮 `modelTurn` 继续运行

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: 工具调用测试通过。

## Task 5: 增加失败和边界红灯测试

Modify: `test/reactAgentRunner.test.ts`

新增测试：

- 未知工具转成 `runFailed`。
- 超过 `maxSteps` 转成 `runFailed`。
- request signal 已取消时停止输出。

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: 至少一个新增测试失败，原因是边界处理尚未完整实现。

## Task 6: 实现边界处理

Modify:

- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/agent/toolRegistry.ts`

实现：

- `maxSteps`
- `maxToolRequestsPerStep`
- 取消检查
- 受控错误格式化

Run: `npm test -- test/reactAgentRunner.test.ts`

Expected: ReAct runner 定向测试通过。

## Task 7: 清理、导出和全量验证

Modify:

- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/agent/reactTypes.ts`
- `src/extension/agent/toolRegistry.ts`
- `src/extension/agent/tools.ts`

验证：

- `npm test -- test/reactAgentRunner.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run compile`

Expected: 所有验证通过，没有临时调试代码、未使用导出或与实现不一致的文档。
