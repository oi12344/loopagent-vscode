# 动态工作流演示：自适应 API 集成任务

## 用户提问（模拟）

> "帮我集成 GitHub API：先读取我的 personal access token，然后测试能不能访问；如果失败就生成一个诊断报告；如果成功就并发拉取我的 top 3 repo 的 issue 数据，每个 repo 如果拉取失败就重试 2 次；最后把所有数据汇总成一份 markdown 报告，但你写完初稿之后必须自己 review 一遍，如果格式有问题就自己修正，最多改 3 轮，改好了再给我。"

## 这个需求触发的调度模式

```
初始并行层
├─ read-token ──┬──► test-access ──┬──(成功)──┬──► fetch-repo-1 [retry:2] ──┐
│               │                   │          ├──► fetch-repo-2 [retry:2] ──┼──► aggregate ──► review-1 ──(不合格)──► revise-2 ──► review-2 ──(合格)── 停止
│               │                   │          └──► fetch-repo-3 [retry:2] ──┘
│               │                   │
│               │                   └──(失败)──► diagnose [onFailure 条件]
│               │
│               └─ read-config (并行，不依赖 token)
```

### 涉及的整改特性

| 节点 | 用到的特性 | 对应任务 |
|------|-----------|---------|
| `test-access` | `inputMapping: { token: "read-token.content" }` 把 token 注入子代理 prompt | T1 |
| `diagnose` | `condition: { type: "custom", expression: "test-access.status === 'failed'" }` | T2 |
| `fetch-repo-*` 三节点 | `dependsOn: ["test-access"]` 静态声明，无需 resolver | T5 |
| `fetch-repo-*` | 并发启动（无互相依赖），一个完成立刻解锁 `aggregate`，不等其他兄弟 | T6 |
| `fetch-repo-*` | `retry: { maxAttempts: 2, backoffMs: 1000 }` | T9 |
| `aggregate` | `inputMapping: { repos: ["fetch-repo-1.content", ...] }` 读取上游数组 | T1 |
| `aggregate` | `exportTo: "draft"` 写入 globalData | T7 |
| `review-1` | `dependsOn: ["aggregate"]`；resolver 判断输出是否含 "APPROVED" | T10 (反思循环) |
| `revise-2` | 由 review-1 的 resolver 动态创建，`inputMapping: { feedback: "$draft" }` 从 globalData 读 | T7 + T10 |
| 用户中途取消 | 未完成节点标记 `cancelled`，触发 `GraphCancelled` 事件（不是 `GraphCompleted`） | T8 |
| 所有子代理 | 完成/失败后自动写入 `task_runs` 表，敏感内容（token）被 `sanitizeSummary` 脱敏 | T11 |

## 实现代码（简化版）

```typescript
import { createDynamicGraphEngine } from "./workflow/dynamicGraphEngine";
import { createReflectionResolver } from "./workflow/reflectionResolver";
import type { DynamicGraphDefinition } from "./workflow/dynamicGraphTypes";

const resolvers = new Map();
const reflectionResolver = createReflectionResolver(resolvers, {
  maxRounds: 3,
  judge: (reviewResult) => ({
    approved: reviewResult.content?.includes("APPROVED"),
    feedback: reviewResult.content,
  }),
  reviseTask: (round, verdict) => 
    `修正报告（第 ${round} 轮）：\n${verdict.feedback}\n\n原始草稿见 $draft`,
  reviewTask: (round) => 
    `检查报告格式（第 ${round} 轮）：目录、代码块、表格是否规范？只输出 APPROVED 或具体问题`,
});
resolvers.set("review-1", reflectionResolver);

const definition: DynamicGraphDefinition = {
  initialNodes: [
    { id: "read-token", task: "读取 ~/.github-token 文件内容" },
    { id: "read-config", task: "读取 repo 配置" }, // 与 token 无依赖，可并行
    {
      id: "test-access",
      task: "用 token 测试 GitHub API 连通性",
      dependsOn: ["read-token"],
      inputMapping: { token: "read-token.content" }, // T1
    },
    {
      id: "diagnose",
      task: "生成 GitHub 连接失败诊断报告",
      dependsOn: ["test-access"],
      condition: { type: "custom", expression: "test-access.status === 'failed'" }, // T2
    },
    {
      id: "fetch-repo-1",
      task: "拉取 repo angular/angular 的 issues",
      dependsOn: ["test-access"],
      condition: { type: "custom", expression: "test-access.status === 'completed'" },
      retry: { maxAttempts: 2, backoffMs: 1000 }, // T9
      inputMapping: { token: "read-token.content", repo: "angular/angular" },
    },
    {
      id: "fetch-repo-2",
      task: "拉取 repo vuejs/core 的 issues",
      dependsOn: ["test-access"],
      condition: { type: "custom", expression: "test-access.status === 'completed'" },
      retry: { maxAttempts: 2, backoffMs: 1000 },
      inputMapping: { token: "read-token.content", repo: "vuejs/core" },
    },
    {
      id: "fetch-repo-3",
      task: "拉取 repo facebook/react 的 issues",
      dependsOn: ["test-access"],
      condition: { type: "custom", expression: "test-access.status === 'completed'" },
      retry: { maxAttempts: 2, backoffMs: 1000 },
      inputMapping: { token: "read-token.content", repo: "facebook/react" },
    },
    {
      id: "aggregate",
      task: "汇总所有 repo 数据，生成 markdown 初稿",
      dependsOn: ["fetch-repo-1", "fetch-repo-2", "fetch-repo-3"],
      inputMapping: {
        angular: "fetch-repo-1.content",
        vue: "fetch-repo-2.content",
        react: "fetch-repo-3.content",
      },
      exportTo: "draft", // T7: 写入 globalData，供后续 revise 节点读取
    },
    {
      id: "review-1",
      task: "检查报告格式（第 1 轮）：目录、代码块、表格是否规范？只输出 APPROVED 或具体问题",
      dependsOn: ["aggregate"],
      // reflectionResolver 会在 review-1 完成时判断输出，不合格则动态创建 revise-2
    },
  ],
  resolvers,
  maxDepth: 15, // 限制反思循环最多 ~5 轮（每轮 revise+review 占 2 层深度）
};

const engine = createDynamicGraphEngine({
  definition,
  orchestrator, // 已在外部创建，注入了 projectMemory（T11）
  availableTools,
});

const results = await engine.execute();
```

## 运行时行为（时间线）

```
T+0ms    [read-token] + [read-config] 并行启动（无依赖）
T+50ms   [read-token] 完成 → 解锁 [test-access]
T+60ms   [test-access] 启动（拿到 token = "ghp_xxxx"）
T+200ms  [test-access] 完成（成功）
         → [diagnose] 被 skip（条件不满足）
         → [fetch-repo-1/2/3] 三节点并行启动（T6 连续调度）
T+300ms  [fetch-repo-1] 第一次尝试失败 → 延迟 1s 后重试（T9）
T+400ms  [fetch-repo-2] 完成
T+500ms  [fetch-repo-3] 完成
T+1300ms [fetch-repo-1] 第二次尝试成功
         → [aggregate] 启动（三个依赖全部 terminal）
T+1500ms [aggregate] 完成，输出写入 globalData["draft"]（T7）
         → [review-1] 启动
T+1700ms [review-1] 完成，输出 "REJECTED: 缺少目录"
         → reflectionResolver 判断不合格，动态创建 [reflect-revise-2]（T10）
T+1750ms [reflect-revise-2] 启动，prompt 包含 "$draft" 引用（T7）
T+2000ms [reflect-revise-2] 完成
         → 其 resolver 创建 [reflect-review-2]
T+2200ms [reflect-review-2] 完成，输出 "APPROVED"
         → reflectionResolver 判断合格，不再创建新节点
         → 图收敛，触发 GraphCompleted 事件（T8）

--- 后台：所有子代理（除 cancelled 的）的 outcome 已写入 task_runs 表（T11）---
--- token "ghp_xxxx" 在记录中被脱敏为 "[redacted: sensitive content omitted]" ---
```

## 与 Hermes "自我进化"对比

| 需求 | Hermes 做法 | 动态图做法（本次整改后） |
|------|-----------|---------------------|
| 并发拉取 3 个 repo | 自动并行 `gather` primitive，内置结果聚合 | 显式 3 个独立节点 + `aggregate` 节点读取，T6 连续调度保证并发启动 |
| 拉取失败重试 | 隐式（框架层决策） | 显式 `retry: { maxAttempts: 2 }`（T9），重试逻辑对用户可见 |
| 条件路由（成功/失败） | `conditional` primitive 自动识别前置任务状态 | `condition: { type: "custom", expression: "..." }`（T2） |
| 反思循环 | `refine` primitive 包装 judge/revise/max_iterations | `createReflectionResolver` 工厂（T10），每轮是独立节点，不覆写状态 |
| 子任务经验入库 | 所有子任务默认记录到共享记忆，带自动证据收集 | `WorkflowOrchestrator` 代表子代理调用 `recordOutcome`（T11），evidence 恒为空（无 LLM 参与） |
| 数据传递 | `inputMapping` 与 Hermes 的 `read_from` 等价 | T1 实现后才真正可用（之前是空转） |

**核心差异**：Hermes 的 primitive 是**声明式能力**（你说要并行，框架决定怎么调度；你说要 refine，框架决定何时停止），动态图是**过程式编排**（你自己写清楚 3 个节点、自己注册 resolver、自己判断何时收敛）。前者对 LLM 友好（少犯错），后者对人类可控（每个决策点都显式）。

## 这个例子为什么能跑起来

因为 T1–T10 修复了**所有阻塞点**：
- T1 之前：`inputMapping` 不注入 → token 永远是 `undefined`，test-access 必失败
- T2 之前：`custom` 条件不求值 → diagnose 不管 test-access 结果如何都会跑
- T5 之前：初始节点不能写 `dependsOn` → 必须用 resolver 手写所有边，代码量 3 倍
- T6 之前：波次屏障 → fetch-repo-1 完成后必须等 2/3 也完成才能解锁 aggregate，串行化
- T9 之前：无重试 → fetch-repo-1 一次失败就终态，后续节点全 skip
- T10 之前：无反思循环工厂 → 手写 resolver 互相注册，代码量 5 倍且易错

整改前这个例子会在第一个 `inputMapping` 就卡死（T1），即使手动绕过也会在 `dependsOn` 处因为要写 resolver 而放弃（T5），即使坚持写完也会因为波次屏障变成串行（T6），完全达不到用户预期的"并发 + 自适应 + 自我修正"效果。
