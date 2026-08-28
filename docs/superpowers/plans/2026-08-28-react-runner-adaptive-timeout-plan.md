# 实施计划：主 ReAct Runner 接入自适应超时

## 任务拆解

1. **类型与配置**
   - `CreateReactAgentRunnerOptions` 增加 `runTimeoutMs?`、`maxRunTimeoutMs?`。
   - `createReactAgentRunner` 解构这两个值；`maxRunTimeoutMs` 默认取 `runTimeoutMs * 3`（未启用时为 `undefined`）。

2. **signal 包裹**
   - `run()` 解构 `signal` 重命名为 `externalSignal`。
   - 创建 `internalAbort = new AbortController()`，外部 abort 时联动 abort；新增 `const signal = internalAbort.signal`，后续所有使用点自动指向内部 signal。

3. **消息收集**
   - `run()` 内维护 `hostMessages: HostToWebviewMessage[]`。
   - `toolCallStarted` yield 处先 push 到 `hostMessages` 再 yield。

4. **deadline 评估**
   - `run()` 开始记录 `startTimestamp` 与 `deadline = startTimestamp + runTimeoutMs`（未启用则 `undefined`）。
   - 每步开头（既有 `if (signal.aborted) return` 之后）插入评估逻辑：调用 `evaluateTimeoutAdjustment(hostMessages)`，`multiplier >= 1.5` 延长、`multiplier < 1` 不续命、超时则 abort + yield `runFailed` + return。

5. **清理**
   - `finally` 中 `externalSignal.removeEventListener("abort", ...)`。

6. **测试与验证**
   - 新增上述 3 个单测；运行 `npm run typecheck` 与 `vitest run test/reactAgentRunner.test.ts`。

## 验收步骤

- [x] `runTimeoutMs` 未设置时，现有行为完全不变（改动前后 failed 数量一致：均为 1 个预存在失败，与本改动无关）。
- [x] 设置小预算且工具调用模式触发超时 → 产出 `runFailed`（含超时文案）。测试 `aborts with runFailed when the adaptive timeout budget is exceeded` 通过。
- [x] 设置预算且正常任务在预算内完成 → `runFinished`。测试 `completes normally when the adaptive timeout budget is set but not exceeded` 通过。
- [x] `npm run typecheck` 无错误。
- [x] 更新本计划完成记录与 specs 验收状态。

## 备注

- 既有测试 `reactAgentRunner.test.ts` 存在一个与本次改动无关的失败（多步 `exploreCode` 调用被 `succeededCalls` 重复拦截判定为重复，断言期望全部 `succeeded: true`）。该失败在改动前已存在（stash 验证：改动前 44 passed / 1 failed，改动后 46 passed / 1 failed，新增 2 个测试均通过）。不在本次范围，记录为技术债。