# 主 ReAct Runner 接入自适应超时

## 目标

复用已有的 `src/extension/agent/workflow/adaptiveTimeout.ts`，让主 ReAct runner（`reactAgentRunner.ts`）具备运行时长自我管理：在持续推进（高工具多样性 / 长任务）时延长预算，对重复 / 打转模式不续命，预算耗尽时优雅终止，避免无限运行。

## 范围

- 仅改动 `src/extension/agent/reactAgentRunner.ts` 与对应测试。
- 复用 `evaluateTimeoutAdjustment`，不修改 `adaptiveTimeout.ts`。

## 设计

- 新增选项 `runTimeoutMs`（预算基线，可选，默认 `undefined` = 不启用，行为完全不变）、`maxRunTimeoutMs`（延长硬上限，默认 `runTimeoutMs * 3`）。
- 内部用 `AbortController` 包裹外部 `signal`：原 `signal` 重命名为 `externalSignal`，新增 `const signal = internalAbort.signal`。外部中止或内部 deadline 触发都会经既有 `signal.aborted` 检查点生效。
- 收集 `toolCallStarted` 事件到 `hostMessages`，供 `evaluateTimeoutAdjustment` 评估工具调用模式（该函数以 `toolCallStarted` 为主要输入）。
- 每步开头评估一次：
  - `suggestedMultiplier >= 1.5`（高多样性 / 长任务）：`deadline = min(maxRunTimeoutMs, deadline + ADAPTIVE_EXTEND_STEP_MS)`。
  - `suggestedMultiplier < 1`（重复 / 打转迹象）：不续命，保持基线预算（让其在基线到期时自然终止，已有 `succeededCalls` 重复拦截作为辅助）。
  - `now >= deadline`：`internalAbort.abort()` + `yield runFailed(timeout)` + `return`。
- `finally` 中移除 `externalSignal` 的 abort 监听，避免泄漏。

## 取舍

- 复用而非重写评估逻辑，避免重复实现与行为分歧。
- 默认不启用，保持向后兼容；调用方按场景配置预算。
- deadline 在 step 边界检查，不中断进行中的单次工具调用（与 orchestrator 的进度检查点语义一致）。

## 验证

- 新增单测：
  1. 未设置 `runTimeoutMs` → 行为不变、正常完成。
  2. 设置小预算且工具调用模式触发超时 → 产出 `runFailed`（timeout）。
  3. 设置预算且正常任务在预算内完成 → 正常 `runFinished`。
- `npm run typecheck` 通过，相关测试通过。

## 关联

- `workflowOrchestrator.ts` 已用相同 `evaluateTimeoutAdjustment` 管理子代理超时；本改动使其在主 agent 路径上保持一致能力。
