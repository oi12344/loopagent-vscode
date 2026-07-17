# ReAct 单步同名工具去重实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **状态注记：** 本计划中的 `maxSteps = 4` 和触顶 `runFailed` 已被 [ReAct 强制最终回答实施计划](./2026-07-16-react-forced-final-answer-plan.md) 取代；单步同名工具去重、请求/结果配对和提示词约束等其余结论仍有效。

**目标：** 同一模型步骤内，同名工具只实际执行一次，同时为所有请求保留匹配结果，并允许后续步骤再次调用。

**架构：** 在现有 `createReactAgentRunner` 的单步工具循环中使用局部 `Set<string>` 记录已执行工具名。重复请求转换为合成 tool observation；生产 system prompt 同步声明单轮约束，不修改工具类型、registry 或模型协议。

**技术栈：** TypeScript、Vitest、现有 OpenAI-compatible ReAct runtime、VS Code VSIX E2E。

## 全局约束

- 限制范围固定为单个模型步骤，不是整次 run。
- 每个原始 tool call ID 都必须有匹配 tool result。
- `maxSteps = 4`、`maxToolRequestsPerStep = 3` 和触顶 `runFailed` 保持不变。
- 不增加依赖、配置项、工具元数据或通用调度抽象。
- 开发、测试和提交只在 `E:\zz\loopagent-vscode\.worktrees\limit-duplicate-tool-calls` 完成。

---

### 任务 1：限制单步同名工具实际执行次数

**文件：**

- 修改：`test/reactAgentRunner.test.ts`
- 修改：`test/providerRegistryCodeContext.test.ts`
- 修改：`src/extension/agent/reactAgentRunner.ts`
- 修改：`src/extension/model/providerRegistry.ts`
- 更新：`docs/superpowers/plans/2026-07-16-per-turn-tool-dedup-plan.md`

**接口：**

- 消费：现有 `ReactModelTurnResult.requests` 和 `assistantMessage`。
- 产生：首个同名请求的真实 observation，以及重复请求的合成 observation。
- 保持：`ReactAgentTool`、`ReactModelTurn`、`AgentRunner` 类型签名不变。

- [x] **步骤 1：写入失败的行为测试和提示词契约**

将 `test/reactAgentRunner.test.ts` 的 Vitest import 增加 `vi`，新增用例：模型第一步返回两个 `exploreCode` 请求；断言工具 `invoke` 只调用一次，第二模型回合最后三条消息为原始 assistant tool calls、首个真实结果和第二个合成结果，并包含事件：

```typescript
{
  type: "agentEvent",
  runId: "run-1",
  message: "Skipped duplicate tool exploreCode (step 1, call 2)",
}
```

合成结果固定为：

```typescript
{
  role: "tool",
  requestId: "tool-2",
  name: "exploreCode",
  content:
    "Tool exploreCode was skipped because each tool can run only once per step. Review the earlier observation before requesting it again in a later step.",
}
```

把现有查询预览用例改为每个模型步骤只返回一个 `exploreCode` 请求，并设置：

```typescript
maxSteps: queries.length + 1
```

事件期望使用 `step ${index + 1}, call 1`，从而继续覆盖长查询截断、路径与凭据隐藏，并证明后续步骤仍可再次调用同名工具。

在 `test/providerRegistryCodeContext.test.ts` 增加：

```typescript
expect(systemPrompt).toContain("Request each tool at most once per assistant turn");
expect(systemPrompt).toContain("request it again in a later turn");
```

- [x] **步骤 2：运行定向测试并确认红灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts
```

预期：重复工具用例因 `invoke` 被调用两次且缺少跳过 observation 而失败；提示词契约因生产 prompt 缺少新规则而失败。测试不得出现类型或环境错误。

- [x] **步骤 3：实现最小 Runtime 约束**

在 `messages.push(result.assistantMessage)` 后、请求循环前创建：

```typescript
const usedToolNames = new Set<string>();
```

每个请求在真实执行前检查：

```typescript
if (usedToolNames.has(request.name)) {
  const content = `Tool ${request.name} was skipped because each tool can run only once per step. Review the earlier observation before requesting it again in a later step.`;
  yield {
    type: "agentEvent",
    runId,
    message: `Skipped duplicate tool ${request.name} (step ${step}, call ${call})`,
  } satisfies HostToWebviewMessage;
  messages.push({ role: "tool", requestId: request.id, name: request.name, content });
  continue;
}
usedToolNames.add(request.name);
```

集合不得移到外层 run 作用域。

- [x] **步骤 4：补充生产提示词**

在 `REACT_SYSTEM_PROMPT` 的搜索收敛规则中增加：

```typescript
"Request each tool at most once per assistant turn. If more evidence is needed, wait for its observation and request it again in a later turn.",
```

- [x] **步骤 5：运行定向测试并确认绿灯**

```powershell
npm test -- --run test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts
```

预期：两个测试文件全部通过。

- [x] **步骤 6：执行集中验证**

独立运行：

```powershell
npm run typecheck
npm test
npm run compile
git diff --check
```

预期：全部退出 `0`。随后打包当前 worktree VSIX，在唯一调试窗口中运行现有代码探索 E2E，并读取 Process 状态确认每个 `Planning step` 最多一次 `Running tool exploreCode`。

- [x] **步骤 7：记录结果并提交实现**

在本文末尾追加中文实施结果，记录红灯、绿灯、全量验证、E2E 查询次数和已知限制，然后提交：

```powershell
git add -- src/extension/agent/reactAgentRunner.ts src/extension/model/providerRegistry.ts test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts docs/superpowers/plans/2026-07-16-per-turn-tool-dedup-plan.md
git commit -m "fix(agent): limit duplicate tool calls per step"
```

## 实施结果

- 红灯：`npm test -- --run test/reactAgentRunner.test.ts test/providerRegistryCodeContext.test.ts` 得到 2 个预期失败、9 个通过。失败原因分别为同一步内 `invoke` 被调用 2 次，以及生产 prompt 缺少单轮同名工具约束；没有类型或环境错误。
- 绿灯：完成 Runtime 和 prompt 修改后，同一命令得到 2 个测试文件、11 个测试全部通过。
- 集中验证：`npm run typecheck`、`npm run compile` 和 `git diff --check` 均退出 `0`；`npm test` 得到 50 个测试文件、275 个测试全部通过。
- 真实 E2E：打包当前 worktree VSIX 后，在唯一的 Extension Development Host 中运行 `npm run test:e2e:code-exploration`，代码锚点和路径断言全部通过，最终答案正常生成。
- E2E 调用明细：步骤 1 实际执行 1 次 `exploreCode`；步骤 2、3 均收到 2 个同名请求，但各只实际执行第 1 个并跳过第 2 个；步骤 4 直接 `Done`。整次运行共实际搜索 3 次、跳过重复请求 2 次，每个步骤最多 1 次真实 `exploreCode` 调用。
- 行为边界：去重集合只存在于单个模型步骤；后续步骤仍可再次调用同名工具。被跳过的请求仍写入匹配原始 `requestId` 的合成 tool observation，避免破坏模型协议中的 tool call/result 配对。
