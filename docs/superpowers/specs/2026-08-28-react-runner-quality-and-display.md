# ReAct Runner 质量与展示改进设计规格

## 目标

提升主 ReAct runner（`src/extension/agent/reactAgentRunner.ts`）的健壮性、可观测性与死循环防护，并让 webview 展示模型在工具调用前的解释文本，使「思考过程」对用户可见。

## 范围与取舍

### 1. 去重护栏误判修复

- 问题：预存在测试 `reports distinct and safe exploreCode progress for every call` 失败，多步 `exploreCode` 被 `succeededCalls` 判为重复调用而拒绝。
- 根因：`computeToolCallSignature` 对参数值做 `slice(0, 100)` 截断，导致前 100 字符相同的不同长参数（如仅空白差异）签名相同，被误拒为「重复调用」。
- 方案：去掉截断，完整序列化参数值（字符串用原值，非字符串用 `JSON.stringify`）。签名仅用作内存 `Map` 的 key，长度可接受。
- 取舍：签名可能更长，但消除了「误拒合法不同调用」这一正确性问题。`runCommand` 分支的归一化逻辑保持不变。

### 2. 工具调用前解释文本展示

- 方案：常规工具步骤（`result.kind === "toolRequests"`）在推送 `assistantMessage` 之后，若 `assistantMessage.content` 非空，额外 yield 一个 `assistantDelta` 携带该文本。
- webview：`AssistantMessage` 渲染顺序由「工具块在前、文本在后」调整为「文本在前、工具块在后」，使解释文本出现在工具调用上方。
- 取舍：复用既有 final 答案的同一条 `assistantDelta` → `updateAssistantTurn` 渲染路径，不新增消息类型，改动面最小。

### 3. Runner 健壮性收尾

- 魔法数字：循环上限 `maxSteps + 1 + 2` 提取为 `STEP_SAFETY_OVERSHOOT = 3`（1 步留给最终答案 `isFinalAnswerStep`，2 步安全余量应对 `requiredTool` 等重试），消除魔法数字。
- 并发重复检测：在 `createToolRequestBatches` 的并发批次内，若同一批次存在相同签名调用，直接返回「重复调用」提示而不真正并发执行，修复原注释所述的同批次并发漏判。
- `toolFailures`：经核查已是 `Map<工具名, 连续失败数>`，成功时重置该工具，按工具名的「连续失败」语义已成立，无需改动。

### 4. 自适应超时主动缩短（增强）

- 在既有 `runTimeoutMs` / `maxRunTimeoutMs` 自适应超时基础上，增加「连续低多样性步」检测：每步开头用 `evaluateTimeoutAdjustment` 评估，当 `suggestedMultiplier < 1`（重复 / 打转）时 `consecutiveLowDiversity += 1`；达到 `MAX_LOW_DIVERSITY_STEPS = 3` 时主动 `internalAbort` 并产出 `runFailed`（文案 `Run terminated early: repetitive low-diversity steps detected.`）。高多样性或稳定推进时重置计数。
- 取舍：仅在使用自适应超时（`runTimeoutMs` 已设置）时启用，与「预算耗尽终止」互补，更快跳出死循环而非干等预算耗尽。

## 验证方式

- `test/reactAgentRunner.test.ts` 相关用例：
  - `reports distinct and safe exploreCode progress for every call`（原失败，现已转绿）
  - `pre-tool explanation text > yields assistantDelta carrying the explanation before tool calls`
  - `duplicate tool call guard > marks the second identical call in the same step as a duplicate`
  - `adaptive early termination > terminates early on repetitive low-diversity steps`
- `npm run typecheck` 无错误；`test/reactAgentRunner.test.ts` 全量 50 用例通过。
