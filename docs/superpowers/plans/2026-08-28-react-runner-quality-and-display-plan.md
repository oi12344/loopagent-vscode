# ReAct Runner 质量与展示改进实施计划

## 实施步骤

1. 修复 `computeToolCallSignature` 参数截断（去掉 `slice(0, 100)`）。
2. runner 常规工具步骤（非 final）在推送 `assistantMessage` 后，若 `content` 非空则 yield 一个 `assistantDelta`。
3. `AssistantMessage` 渲染顺序调整：先 `content`（解释文本）后 `AssistantProcess`（工具块）。
4. 提取 `STEP_SAFETY_OVERSHOOT = 3` 常量替换循环上限魔法数字 `maxSteps + 1 + 2`。
5. 并发批次内重复签名预检测：同批次相同签名直接判重，不真正并发执行。
6. 增加 `consecutiveLowDiversity` 与 `MAX_LOW_DIVERSITY_STEPS = 3`，连续低多样性步主动 `runFailed` 终止。
7. 补充测试，运行 `npm run typecheck` 与 `npx vitest run test/reactAgentRunner.test.ts`。

## 验收

- [x] 预存在失败测试转绿（去重不再误判前 100 字符相同的长参数）。
- [x] 常规工具步骤产出 `assistantDelta` 携带解释文本。
- [x] 并发批次内重复调用被标记为重复（不真正执行）。
- [x] 连续 3 步低多样性触发 `runFailed`（repetitive low-diversity）。
- [x] `npm run typecheck` 无错误；`test/reactAgentRunner.test.ts` 50 passed。
- [x] 本轮设计 / 计划文档落地（`docs/superpowers/specs/2026-08-28-react-runner-quality-and-display.md` 与本计划）。
