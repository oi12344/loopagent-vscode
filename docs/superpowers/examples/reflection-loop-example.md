# 反思循环用例：execute → review → revise

对应整改计划 [T10](../plans/2026-07-26-dynamic-workflow-remediation-plan.md#t10-反思循环模式基于-resolver-的迭代展开)。用 `createReflectionResolver`（[reflectionResolver.ts](../../../src/extension/agent/workflow/reflectionResolver.ts)）把"执行 → 评审 → 不合格就修正"的自我反思循环，展开成一条无环的节点链，而不是在图里引入真正的环。

## 为什么不用真环

- `maxDepth` 天然成为最大反思轮数上限，不需要额外的 `recursion_limit` 机制。
- 每一轮都是独立节点，执行轨迹完整可审计（真环会覆写同一节点的状态，丢失历史）。
- 复用现有的 DAG 校验（环检测、深度限制），不需要为动态图单独实现终止性证明。

## 用法

```typescript
import { createDynamicGraphEngine } from "./workflow/dynamicGraphEngine";
import { createReflectionResolver } from "./workflow/reflectionResolver";
import type { DynamicGraphDefinition, DependencyResolver } from "./workflow/dynamicGraphTypes";
import type { DynamicNodeId } from "./workflow/dynamicGraphTypes";

const resolvers = new Map<DynamicNodeId, DependencyResolver>();

const reflectionResolver = createReflectionResolver(resolvers, {
  maxRounds: 3,
  // judge 是纯函数：解析评审节点的输出，决定是否通过、以及要不要带反馈进入下一轮
  judge: (reviewResult) => {
    const approved = reviewResult.content?.trim() === "APPROVED";
    return { approved, feedback: reviewResult.content };
  },
  // 修正节点的任务文本；round/verdict 由框架传入
  reviseTask: (round, verdict) => `根据以下评审意见修改代码（第 ${round} 轮）：\n${verdict.feedback}`,
  reviewTask: (round) => `评审第 ${round} 轮的修改，只输出 APPROVED 或具体问题`,
});

// 第一轮评审节点的 id 必须和这里注册的 key 一致
resolvers.set("review-1", reflectionResolver);

const definition: DynamicGraphDefinition = {
  initialNodes: [
    { id: "execute", task: "实现功能 X" },
    { id: "review-1", task: "评审第 1 轮的实现，只输出 APPROVED 或具体问题", dependsOn: ["execute"] },
  ],
  resolvers,
  maxDepth: 10, // 隐式限制最多 ~4-5 轮反思（execute + 每轮 revise+review 各占一层深度）
};

const engine = createDynamicGraphEngine({ definition, orchestrator, availableTools });
const results = await engine.execute();
```

## 收敛机制

```
execute → review-1 ──(不合格)──► reflect-revise-2 ──► reflect-review-2 ──(不合格)──► reflect-revise-3 ──► reflect-review-3 ──(合格)── 停止
```

- 评审节点的 resolver 只在"不合格且轮次未耗尽"时生成下一个修正节点；合格或达到 `maxRounds` 时返回空数组，图自然收敛（无需额外的终止节点或状态机）。
- 单次 resolver 调用返回的所有新节点，依赖关系都固定指向"当前正在 resolve 的节点"（见 `dynamicGraphEngine.ts` 的 `resolveDependencies`），所以"修正→评审"这一步必须拆成两个互相注册的 resolver：评审节点的 resolver 只创建修正节点；修正节点自己的 resolver 再创建下一轮评审节点。调用方不需要关心这个细节——`createReflectionResolver` 内部已经处理好了自注册。
- 修正节点的 `inputMapping: { previousReview: "<reviewId>.content" }` 依赖 [T1](../plans/2026-07-26-dynamic-workflow-remediation-plan.md#t1-inputmapping-注入子代理-prompt) 才能把评审意见真正送进下一轮子代理的 prompt——如果 T1 没有落地，修正节点看到的永远是空上下文，等于每轮都是瞎猜。

## 在合格结果上挂下游门控（结合 T2 的 custom 条件）

如果需要"只有最终评审通过才允许发布"这类下游节点，用 `custom` 条件挂在依赖最后一轮评审节点的下游即可，不需要 `createReflectionResolver` 本身知道"发布"这件事：

```typescript
{
  id: "publish",
  task: "发布最终版本",
  dependsOn: ["reflect-review-3"], // 假设已知会跑到第 3 轮；更通用的做法是让 judge 把最终 reviewId 写入 globalData，用 $var 引用
  condition: { type: "custom", expression: "reflect-review-3.content" }, // 内容非空即视为真值（"APPROVED" 是 truthy 字符串）
}
```

由于轮数在图构建时不一定能提前确定，更健壮的做法是在 `judge` approved 时通过 `exportTo`/`setGlobalData`（见 [T7](../plans/2026-07-26-dynamic-workflow-remediation-plan.md#t7-globaldata-写入口)）把"最终评审是否通过"写入一个固定的 globalData key，下游节点统一用 `condition: { type: "custom", expression: "$approved" }` 判断，而不必硬编码某一轮的节点 id。
