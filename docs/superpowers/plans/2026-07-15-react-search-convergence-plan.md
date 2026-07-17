# ReAct 搜索收敛实施计划

> **执行要求：** 实施时使用 `superpowers:test-driven-development`，按本计划的红灯、绿灯顺序完成。

**目标：** 让生产 ReAct 模型在搜索结果足够时立即回答，仅在存在必要且具体的证据缺口时继续执行不重叠查询。

**架构：** 复用现有 `REACT_SYSTEM_PROMPT` 作为模型决策入口，不修改 ReAct runner、工具协议或搜索实现。现有生产 runner 集成测试捕获真实发送给 provider 的 system message，以验证收敛契约确实进入模型上下文。

**技术栈：** TypeScript、Vitest、现有 OpenAI-compatible ReAct runtime。

## 全局约束

- 正常路径由模型判断证据是否充分，Runtime 不强制一次搜索后结束。
- `maxSteps = 4`、每步工具请求上限和触顶 `runFailed` 行为保持不变。
- 不增加依赖、工具、配置项、状态类型或通用抽象。
- 功能与验证记录使用中文；生产 system prompt 保持现有英文风格。

---

### 任务 1：增加并实现生产搜索收敛契约

**文件：**

- 修改：`test/providerRegistryCodeContext.test.ts`
- 修改：`src/extension/model/providerRegistry.ts`
- 更新：`docs/superpowers/plans/2026-07-15-react-search-convergence-plan.md`

**接口：**

- 输入：`createConfiguredAgentRunner(...)` 生成的首轮模型消息。
- 输出：包含证据充分性判断、具体缺口条件和查询去重要求的生产 system message。
- 保持：`AgentRunner`、`ReactModelTurn` 和 `exploreCode` 接口不变。

- [x] **步骤 1：写入失败的契约测试**

在现有首个生产 runner 用例的 system prompt 断言后增加：

```typescript
expect(systemPrompt).toContain(
  "If the available source evidence is sufficient, answer immediately without calling another tool.",
);
expect(systemPrompt).toContain(
  "Only call exploreCode again for a concrete missing fact required to answer the user",
);
expect(systemPrompt).toContain("does not overlap previous queries");
```

- [x] **步骤 2：运行定向测试并确认红灯**

运行：

```powershell
npm test -- --run test/providerRegistryCodeContext.test.ts
```

预期：首个用例因 system prompt 缺少新增收敛文本而失败；其余测试不应发生编译或环境错误。

- [x] **步骤 3：补充最小生产提示词**

在 `REACT_SYSTEM_PROMPT` 现有源码验证规则后加入：

```typescript
"After each exploreCode observation, decide whether the available source evidence is sufficient to answer the user's question.",
"If the available source evidence is sufficient, answer immediately without calling another tool.",
"Only call exploreCode again for a concrete missing fact required to answer the user; use a focused query that does not overlap previous queries.",
"Do not keep searching for completeness or to reconfirm facts already supported by source evidence.",
"Answer only from supported evidence and state any material limitation.",
```

- [x] **步骤 4：运行定向测试并确认绿灯**

运行：

```powershell
npm test -- --run test/providerRegistryCodeContext.test.ts test/reactAgentRunner.test.ts
```

预期：两个测试文件全部通过；现有一次 `exploreCode` 后返回最终回答、`maxSteps` 触顶失败和工具事件行为保持不变。

- [x] **步骤 5：执行集中验证**

独立运行：

```powershell
npm run typecheck
npm test
npm run compile
git diff --check
```

预期：所有命令退出码为 `0`。若本机已有可复用的唯一 LoopAgent 调试窗口和可用 DeepSeek 凭据，再运行现有真实代码探索路径；否则记录未执行原因，不创建第二个窗口。

- [x] **步骤 6：更新计划结果并提交实现**

在本文末尾追加简短中文结果，记录红灯原因、定向测试、全量测试、类型检查、构建和 `git diff --check` 结果，然后提交：

```powershell
git add -- src/extension/model/providerRegistry.ts test/providerRegistryCodeContext.test.ts docs/superpowers/plans/2026-07-15-react-search-convergence-plan.md
git commit -m "fix(agent): converge code search decisions"
```

## 实施结果

- 红灯：`test/providerRegistryCodeContext.test.ts` 的 2 个用例中 1 个按预期失败，原因为生产 system prompt 缺少“证据足够立即回答”契约。
- 绿灯：相关两个测试文件共 10 个用例全部通过。
- 集中验证：类型检查、生产编译和 `git diff --check` 均退出 `0`；全量测试共 50 个文件、274 个用例全部通过。
- 真实模型 E2E：本机没有 `DEEPSEEK_API_KEY` 环境变量，固定调试端口 `9333` 没有现有窗口，因此未启动新的 VS Code 实例，未执行该可选验证。
