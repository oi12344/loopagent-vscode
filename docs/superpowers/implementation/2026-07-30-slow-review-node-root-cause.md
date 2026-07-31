# 为什么"审查代码"节点执行很慢 —— 根因与修复

**日期**: 2026-07-30

## 真正的根因（不是 schema、不是 idPrefix）

`dataFlowManager.evaluateExpression` 里有两个独立的解析 bug，二者叠加导致
`condition.expression: "!code-review.content.includes('APPROVED')"`
这种（示例文档里到处都是的）标准写法**从来没有被正确解析过**：

### Bug 1：`.includes()` 检查顺序早于取反 `!`

```js
// 修复前的检查顺序
1. /^(.+?)\.includes\(['"](.+?)['"]\)$/   // 非贪婪 (.+?) 会把开头的 "!" 一起吞进 baseExpr
2. trimmed.startsWith('!')                 // 永远轮不到，因为上面已经"匹配成功"了
```

`!code-review.content.includes('APPROVED')` 被解析成
`(!code-review.content).includes('APPROVED')`，
而不是 `!(code-review.content.includes('APPROVED'))`。

`!code-review.content` 求值为布尔 `false`（非空字符串取反），
`.includes()` 分支看到 `baseValue` 不是字符串就直接 `return false`。

**结果：`fix`/`security-fix` 之类节点的 `condition` 恒为 `false` → 节点被跳过（`skipped`），
而不是在审查未通过时执行修复。** 这正是"审查代码那个节点执行的很慢"背后的连锁反应：
条件求值出错不抛异常、静默返回错误结果，模型看到图执行结果不对，
只能不断换写法重试 `runDynamicGraph`（日志里连续 14+ 次工具调用、近 5 分钟耗时）。

修复：把取反检查挪到 `.includes()` 之前（`dataFlowManager.ts`）。

### Bug 2：`!==` 永远无法被识别

```js
// 修复前
const op2 = expression.slice(index, index + 2);
if (op2 === ">=" || op2 === "<=" || op2 === "!==") { ... }
```

`op2` 只截了 2 个字符，永远不可能等于 3 个字符的字面量 `"!=="`——这个分支是死代码。
同时还有一份重复实现 `findStrictComparison` 才是正确处理 `===`/`!==` 的版本，
但在早前的重构中已经没有任何调用点，变成孤儿代码。

结果：任何用到 `!==` 的表达式（如 `$expected !== null`）都会一路失败到
`Unsupported expression`。

修复：删除孤儿函数 `findStrictComparison`，在 `findComparison` 里改成先截 3 字符
判断 `===`/`!==`，再判断 2 字符的 `>=`/`<=`。

## 附带修复：更好的错误信息与工具文档

- `runDynamicGraph` 的工具描述（`dynamicWorkflowTools.ts`）之前完全没提 `cycles` 字段、
  也没有说明表达式语言的语法边界，模型只能靠猜测——这解释了日志里反复出现的
  `idPrefix must be a non-empty string`、`Unsupported expression: nodes.get(...)` 等错误：
  模型在用它更熟悉的 JS/Python 风格语法（`nodes.get()`、`?.`、`cycleState.x`）去猜测一个
  从未被文档化的 DSL。现已在工具描述、`CYCLE_SCHEMA`、`NODE_SCHEMA.condition.expression`
  中补充了完整的语法说明和一个可直接复制的最小示例。
- `evaluateExpression` 抛出的错误信息原来只有一句 `Unsupported expression: <expr>`，
  模型拿到这句话后只能瞎猜。现在 `unsupportedExpressionMessage()` 会针对
  `nodes.get(`、`?.`、`.length/.match/...`、`cycleState`、`||` 等已知误用模式给出
  针对性提示，并列出当前已知的合法节点 id。

## 验证

- `test/cycleManager.test.ts`：8 passed，3 skipped（跳过的用例依赖尚未实现的
  `cycleState` 表达式上下文与自适应统计细节，属于后续增强，与本次 bug 无关）。
- `test/dynamicGraphCycleIntegration.test.ts`：4/4 通过（此前失败的
  "应该支持简单的审查-修复循环" 现在正确触发循环）。
- `test/dynamicGraphWorkflow.test.ts`：`$expected !== null` 用例恢复通过。
- 全量测试：仅剩 `test/codeReviewTool.test.ts` 的 2 个失败，与本次改动无关
  （未跟踪文件，不依赖 `dataFlowManager`，是前序会话遗留的未完成功能）。

## 结论

CDP 测试里"审查代码节点执行很慢"不是性能问题，是**正确性问题**：修复条件表达式
一直被误判为 `false`，导致该跳过的没跳过、该执行的没执行，模型只能反复摸索
`runDynamicGraph` 的参数格式，44 次工具调用、近 5 分钟才勉强凑出一个能跑通的图。
现在表达式解析器和工具文档都已修正。
