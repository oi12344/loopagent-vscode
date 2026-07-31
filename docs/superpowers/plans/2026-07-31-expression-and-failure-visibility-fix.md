# 表达式语言补全与失败可见性修复记录

## 背景

复核动态工作流「整体流程是否打通」时发现两处真实缺陷，都属于静默失效——不报错，但功能不生效。

## 缺陷一：工具描述承诺的表达式语言有 5/6 未实现

`runDynamicGraph` 的工具描述（`dynamicWorkflowTools.ts` 的 EXPRESSION LANGUAGE 段）向模型逐条
列出可用形式，但 `evaluateExpression` 只实现了其中一部分：

| 描述承诺的形式 | 修复前实际行为 |
|---|---|
| `<nodeId>.content.includes('text')` | 落入 JSON path 分支，`JSON.parse` 失败被 catch 吞掉，**静默返回 null** |
| `!<expr>` | 抛 `Unsupported expression` |
| `<exprA> && <exprB>` | 抛 `Unsupported expression` |
| `>=` `>` `<=` `<` | 抛 `Unsupported expression` |
| `===` `!==` | 可用 |
| `<nodeId>.content` / `$globalKey` | 可用 |

`.includes()` 那条影响最大：它是描述里唯一的子串测试写法，也是 review/fix 循环退出条件的标准
形态。静默返回 `null` 意味着所有 `breakWhen` 条件永不触发，循环只能靠 `hardLimit` 结束，且不留
任何诊断痕迹。工具描述末尾「否则循环只能靠 hardLimit 结束」这句警告，实际描述的是全部
`breakWhen` 的真实命运。这也是 `cycleManager.test.ts` 两个失败用例的根因。

### 修复

`dataFlowManager.ts` 的 `evaluateExpression` 改为递归下降，优先级从低到高：
`&&` → 比较 → 一元 `!` → `.includes()` → 基础项。

- `.includes()` 分支必须早于 JSON path 分支，否则仍会被 JSON path 正则吞掉。
- `findStrictComparison` 泛化为 `findTopLevelOperator`，保留原有的引号跳过逻辑；候选操作符按
  长度降序，避免 `>` 抢先匹配 `>=` 的首字符。
- 数值比较先转数字，无法转换返回 `false` 而不抛错，避免一个写坏的阈值把整张图打挂。
- `.includes()` 遇到节点缺失或无输出返回 `false`——缺输出本身是合法的中间状态。
- `&&` 短路求值：左侧为假时右侧不求值，与 JS 一致。
- 新增 `UNSUPPORTED_MEMBERS` 拦截 `.length`、`.match`、`.trim` 等会被 JSON path 正则误吞的 JS
  成员名，抛错并给出替代写法。这些名字作为 JSON 字段极罕见，作为模型笔误却常见，宁可抛错也
  不要静默返回 `null`。JSON 字段缺失返回 `null` 的既有语义不变
  （`test/dynamicGraphWorkflow.test.ts` 对此有断言）。

## 缺陷二：状态驱动路径的失败对父智能体不可见

- `executeCompiledGraph` 只把 `completed` 结果写入 `results`，失败结果被丢弃，父智能体拿不到错误原文。
- 该路径的 `GraphCompleted` 硬编码 `failedNodes: []`、`unreachedNodes: []`。
- `failedNodes` 这个字段全仓只出现在 workflow 目录的 3 个文件内，工具层和 runner 从不读它。
- 工具返回值里没有任何失败字段，唯一的失败拦截是「零节点完成才抛错」——5 个节点 1 成 4 败仍
  返回成功。

### 修复

- `executeCompiledGraph`：失败结果也写入 `results`（父智能体需要错误原文才能重规划）；仅成功结果
  写 `outputs` 通道并发 `NodeCompleted`，因此下游拿不到失败节点伪造的上下文。
- `GraphCompleted` 按 `context.nodes` 的真实状态计算 `failedNodes` 与 `unreachedNodes`。
- `dynamicWorkflowTools.ts` 订阅 `GraphCompleted`，在返回值中新增 `workflowStatus`
  （`completed` / `failed` / `cancelled`）、`failedNodes`（含 `nodeId` 与 `error` 原文）、
  `unreachedNodes`。两条执行路径都覆盖。

`workflowStatus` 只实现当前能真实反映的三态。治理计划里的 `recovering` / `waiting_input` /
`waiting_external` 依赖尚未实现的 `RecoverySupervisor`，不提前引入无法兑现的状态。

## 附带修复

`vitest.config.ts` 的 exclude 补上 `.local-vscode-extensions/**`。该目录是本地安装的打包产物，
内含随扩展打包的测试文件，被当源码测试扫到会因依赖未随包安装而加载失败。与已排除的 `dist/**`
同属构建输出。

## 验证

| 项目 | 修复前 | 修复后 |
|---|---|---|
| 全量失败用例 | 7 | 5 |
| 全量通过用例 | 694 | 736 |
| 套件加载失败 | 1 | 0 |

- 新增 `test/workflow/expressionLanguageContract.test.ts`：29 个用例，双向锁定——承诺的形式必须
  可用，声明不支持的形式必须抛错而非静默返回假值。
- 新增 `test/workflow/compiledGraphFailureVisibility.test.ts`：5 个用例，锁定引擎侧失败证据。
- 新增 `test/workflow/toolFailureVisibility.test.ts`：6 个用例，锁定工具返回值，覆盖语义与 legacy
  两条路径。测试图刻意包含一个独立成功节点，因为伪成功的真实形态是「部分成功、部分失败」。
- `cycleManager.test.ts` 原有 2 个失败已消除，未修改该测试文件。
- `npm.cmd run compile` 通过。
- `npm.cmd run typecheck`：47 个错误，与修复前数量完全一致，无一落在本次改动的文件上。来源分两类：
  `codeReviewTool.ts`、`javaAdapter.ts`、`javaAstExtractor.ts` 是**尚未提交 git 的新增文件**
  （功能开发未完成）；`App.tsx` 已跟踪但相对 HEAD 零改动，其报错源于 `codeReviewTool.ts` 配套的
  `CodeReviewIssue` / `CodeReviewReport` 类型还没加进 `chatTypes.ts`。两类都与工作流无关。
- 剩余 5 个失败均为既有问题，相对 HEAD 零改动：`App.test.tsx` 2、`codeReviewTool` 2、
  `exploreCodeSpool` 1。

## 仍未打通

`2026-07-31-dynamic-workflow-recovery-governance-plan.md` 的 9 个 Task 全部未开工：
`RecoverySupervisor`、`workflowRecovery.ts`、`workflowCheckpointStore.ts`、
`workflowPlanPolicy.ts` 均不存在。因此「失败后自动恢复 / 等待外部条件后 resume / 副作用对账」
三条路径仍然没有。本次修复只做到「失败可见且带证据」，恢复动作仍需父智能体自行决定。
