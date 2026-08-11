# 04 · 四个角色,四套权限

第 01 篇提到单智能体的第二个死穴:**能力过载**——一个 Agent 同时握着读、写、执行三种能力,在只该读的时候也有能力改。

这个死穴在一类请求上格外扎眼:

> 我这个 PR 明天就要合了,你**先别动代码**,就帮我看看有没有漏掉的边界情况。

"先别动代码"——用户把约束说得不能更清楚了。但请注意一件事:**这句话凭什么能被遵守?**

如果那个负责审查的 Agent 手里握着 `applyEdit`,"别动代码"就只是一句**请求**。它可能读到一段明显写错的分支,顺手就改了;可能把"帮我看看"理解成"帮我修好";甚至可能在某个文件里读到这样一行:

```ts
// TODO: 这个判断是反的,谁看到就顺手修一下
if (user.isActive || user.isBanned) { ... }
```

然后它就"顺手修一下"了。你的 PR 里于是多出一个你没写、没审、也没预料到的改动。

这三种失效方式都不是假想,而是提示词软约束的日常。这篇讲 LoopAgent 的解法,核心思路一句话:**不是告诉子智能体"别改文件",而是不给它 `applyEdit`**。

## 两条工具白名单

整个权限系统的基础就两行:

```ts
// workflow/roleRegistry.ts
const READ_ONLY_TOOLS = ["browseSymbols", "exploreCode", "readFile"] as const;
const EXECUTOR_TOOLS = [...READ_ONLY_TOOLS, "applyEdit", "runCommand"] as const;
```

四个角色分配如下:

| 角色 | 工具 | 能改代码 | 能跑命令 |
|------|------|---------|---------|
| `explorer` | browseSymbols, exploreCode, readFile | ✗ | ✗ |
| `reviewer` | browseSymbols, exploreCode, readFile | ✗ | ✗ |
| `planner` | browseSymbols, exploreCode, readFile | ✗ | ✗ |
| `executor` | 以上三个 + **applyEdit, runCommand** | ✓ | ✓ |

三个只读,一个可写。这个 4:1 的比例本身就是个设计声明——**绝大部分 Agent 工作是只读的**。找代码、读代码、审代码、做计划,都不需要写权限。真正动手改的只有最后一步。

`✶ 为什么"不给工具"比"提示别做"强`
提示词里写 "do not modify files" 是一个**软约束**——模型可能忽略它、可能误判、可能被上游数据里的指令劫持。而工具白名单是**硬约束**:`applyEdit` 不在这个子智能体的 tools 数组里,模型连这个函数名都看不到,发出来的 tool_call 会直接被判为 unknown tool。安全边界应该建在能力层,不是意图层。

## 三个只读角色的差别在提示词

工具一样,那 explorer / reviewer / planner 有什么区别?区别在**system prompt**——同样的工具,不同的目标和输出格式要求。

**explorer** — 找东西,给证据:

```ts
const EXPLORER_PROMPT = [
  "You are a subagent in the explorer role. Your job is to locate source code, symbols, and call paths, and to collect factual evidence.",
  "When you are uncertain what symbols exist, call browseSymbols first to discover actual identifiers, then use those names in exploreCode.",
  "When symbols are known, call exploreCode directly with a focused query. Never enumerate the whole repository, and never pass a directory path to readFile.",
  "Answer with: (1) a concise conclusion, (2) evidence locations as file:line references, (3) any unknowns you could not verify.",
  "Do not speculate beyond what the returned source supports. If evidence is insufficient, say so explicitly.",
].join("\n");
```

三个细节:
- **工具使用顺序被明确规定**:不确定符号名时先 `browseSymbols` 发现真实标识符,再拿这些名字去 `exploreCode`。这防止模型凭想象搜一个不存在的符号名。
- **明确禁止全库枚举**,也禁止把目录路径传给 `readFile`。这两个都是真实发生过的浪费模式。
- **输出格式固定三段**:结论、`file:line` 证据、没验证出来的部分。最后一段最重要——它给了模型一个"承认不知道"的合法出口,否则模型倾向于编。

**reviewer** — 找问题,分严重级:

```ts
const REVIEWER_PROMPT = [
  "You are a subagent in the reviewer role. Your job is to inspect code for defects, regression risks, and test-coverage gaps.",
  "Use browseSymbols to discover relevant symbols when unfamiliar with the codebase, then read the implementation with exploreCode and readFile.",
  "Keep searches focused; never enumerate or read the whole repository.",
  "Answer with findings grouped by severity (blocker / major / minor). Each finding must cite a file:line and describe a concrete failure scenario.",
  "If you find no issues after inspecting the relevant code, say so explicitly rather than inventing concerns.",
].join("\n");
```

关键是最后两句。**每条发现必须给出一个具体的失败场景**——不接受"这里可能有问题"这种空话。以及最后那句明确允许"没发现问题",直接对抗 reviewer 角色最典型的失败模式:为了显得有用而编造顾虑。

回到开头那个"先别动代码"的 PR 审查:主 Agent 派出去的是 `reviewer`,它的 tools 数组里只有 `browseSymbols`、`exploreCode`、`readFile` 三个。那行 `// TODO: 谁看到就顺手修一下` 它照样会读到,但**它没有任何工具能执行"修"这个动作**。发出来的 `applyEdit` 调用会被判为 unknown tool 直接打回。用户那句"别动代码"不是靠模型自觉守住的,是靠工具箱里没有那把锤子。

**planner** — 出计划,不动手:

```ts
const PLANNER_PROMPT = [
  "You are a subagent in the planner role. Your job is to break work into the smallest ordered execution steps based on the current implementation.",
  "Use browseSymbols to discover actual symbol names, then exploreCode and readFile to ground the plan in the codebase. Do not propose steps against code that does not exist.",
  "Keep searches focused; never enumerate or read the whole repository.",
  "Answer with: (1) an ordered list of steps, (2) the files each step touches, (3) verification commands (tests, typecheck, or build).",
  "Do not attempt edits or command execution yourself; you only produce the plan.",
].join("\n");
```

"Do not propose steps against code that does not exist" 是这段的核心——**计划必须落在真实代码上**。planner 有只读工具正是为此:它得先看清现状才能规划。

注意最后一句 "Do not attempt edits or command execution yourself" 其实是**冗余的**——planner 的白名单里本来就没有 `applyEdit` 和 `runCommand`。但写上也无害,提示词和硬约束说同一件事,可以减少模型的无效尝试。

## executor 的提示词最长,因为它要负责验证

```ts
const EXECUTOR_PROMPT = [
  "You are a subagent in the executor role. Your job is to implement the assigned graph node and verify its result.",
  "Use browseSymbols and exploreCode to understand the exact target before editing. Use applyEdit for workspace changes and runCommand only for focused verification.",
  "",
  "After implementing code changes, you MUST verify the result:",
  "1. If the change affects tested code, run relevant tests (e.g., npm test, pytest, cargo test)",
  "2. For TypeScript/JavaScript projects, run type checking if available (npm run typecheck, tsc --noEmit)",
  "3. If the project has a build step, run it to confirm compilation succeeds",
  "",
  "Only report the task as completed if verification passes. If verification fails, fix the issue and re-verify.",
  "If you cannot run verification (no test setup, user denied runCommand), state this limitation explicitly in your response.",
  "",
  "Keep changes limited to the assigned task. Report modified files, commands run, results, and any remaining failure.",
  "Command execution still requires user approval. Never assume access outside the workspace.",
].join("\n");
```

值得注意的是最后那句 "Command execution still requires user approval"。**即使 executor 有 `runCommand`,每条命令仍然要用户批准。** 白名单给的是"可以尝试"的权限,不是"可以自动执行"的权限。这是第二层防线。

还有 "If you cannot run verification ... state this limitation explicitly" ——给了一个诚实的出口。没有它,模型在无法验证时会倾向于说"已验证通过"。

## 角色档案被冻死

```ts
// workflow/roleRegistry.ts
export const ROLE_PROFILES: Readonly<Record<SubagentRoleId, SubagentRoleProfile>> = Object.freeze({
  explorer: Object.freeze({
    id: "explorer",
    systemPrompt: EXPLORER_PROMPT,
    allowedTools: Object.freeze([...READ_ONLY_TOOLS]),
  }),
  reviewer: Object.freeze({
    id: "reviewer",
    systemPrompt: REVIEWER_PROMPT,
    allowedTools: Object.freeze([...READ_ONLY_TOOLS]),
  }),
  planner: Object.freeze({
    id: "planner",
    systemPrompt: PLANNER_PROMPT,
    allowedTools: Object.freeze([...READ_ONLY_TOOLS]),
  }),
  executor: Object.freeze({
    id: "executor",
    systemPrompt: EXECUTOR_PROMPT,
    allowedTools: Object.freeze([...EXECUTOR_TOOLS]),
  }),
});

export const DEFAULT_ROLE: SubagentRoleId = "explorer";

export function resolveRole(role: SubagentRoleId | undefined): SubagentRoleProfile {
  if (role === undefined) return ROLE_PROFILES[DEFAULT_ROLE];
  const profile = ROLE_PROFILES[role];
  if (!profile) throw new Error(`Unknown subagent role: ${role}`);
  return profile;
}
```

三层 `Object.freeze`:外层 record、每个 profile、每个 `allowedTools` 数组。任何运行时给 explorer 偷偷加个 `applyEdit` 的尝试都会失败。

`DEFAULT_ROLE = "explorer"` 也是有意的——**不指定角色时,给最小权限**。这是安全默认值的标准做法:默认应该是最安全的选项,而不是最方便的。

## 两段式工具收窄

角色白名单只是第一道筛。实际分配工具时还有第二道:

```ts
// workflowOrchestrator.ts — createSubagent 里
const profile = resolveRole(config.role);
const context = createSubagentContext({
  id,
  task: config.task,
  role: profile.id,
  dependsOn: dependencies,
  tools: selectTools(config.task, availableTools, config.toolHints, profile.allowedTools),
});
```

`selectTools` 做的事:

```ts
// workflow/toolRouter.ts
const HIGH_COST_TOOLS = new Set(["explorecode"]);

export function selectTools(
  task: string,
  availableTools: readonly ReactAgentTool[],
  toolHints?: readonly string[],
  allowedTools?: readonly string[],
): ReactAgentTool[] {
  const scopedTools = scopeToAllowedTools(availableTools, allowedTools);   // ① 角色白名单过滤
  if (scopedTools.length === 0) return [];

  const hintedNames = new Set(toolHints?.map((hint) => hint.toLowerCase()));
  if (hintedNames.size > 0) {                                              // ② 主 Agent 的显式提示
    const hintedTools = scopedTools.filter((tool) => hintedNames.has(tool.name.toLowerCase()));
    if (hintedTools.length > 0) return hintedTools;
  }

  if (allowedTools) return scopedTools;                                    // ③ 有角色就到此为止

  const taskWords = words(task);                                           // ④ 无角色时的关键词匹配
  const matchedTools = scopedTools.filter(
    (tool) => !HIGH_COST_TOOLS.has(tool.name.toLowerCase()) && [...words(`${tool.name} ${tool.description}`)].some((word) => taskWords.has(word)),
  );
  if (matchedTools.length > 0) return matchedTools;

  return [scopedTools.find((tool) => tool.name === "readFile") ?? scopedTools[0]];
}

function scopeToAllowedTools(
  availableTools: readonly ReactAgentTool[],
  allowedTools?: readonly string[],
): ReactAgentTool[] {
  if (!allowedTools) return [...availableTools];
  const allowedNames = new Set(allowedTools.map((name) => name.toLowerCase()));
  return availableTools.filter((tool) => allowedNames.has(tool.name.toLowerCase()));
}
```

四条路径,但**实际只走前三条**——因为 `createSubagent` 永远传 `profile.allowedTools`,`allowedTools` 不可能是 undefined。所以路径 ④(关键词匹配)在当前接线下是**死代码**,是给未来"无角色子智能体"预留的。

真正生效的是 ① 和 ②:

- **①** 用角色白名单过滤。这一步顺带解决了一个重要问题:传进来的 `availableTools` 是 `parentTools`,里面**包含** `spawnSubagent` 等 workflow 工具。经过 ① 过滤后它们全被剔掉了——这就是"子智能体拿不到派人工具"的实现位置。
- **②** 主 Agent 可以通过 `toolHints` 进一步收窄。比如派一个 explorer 但明确只给 `readFile`。注意 hints 只能在白名单**内**收窄,给不出白名单外的工具。

`✶ 收窄只能单向`
`toolHints` 的过滤是 `scopedTools.filter(...)` ——在已经收窄的集合上再筛。所以主 Agent 无论传什么 hints,都不可能给 explorer 拿到 `applyEdit`。权限系统里,**任何"细化"操作都必须是单调收缩的**,否则细化就成了提权。

## 子智能体的递归本质

最后一块拼图:子智能体到底是什么?

```ts
// model/providerRegistry.ts
const orchestrator = createWorkflowOrchestrator({
  signal: request.signal,
  createRunner: ({ tools, role, invokeTool }) => {
    const childTools = [...tools];
    const childProfile = resolveRole(role);
    return createReactAgentRunner({                    // ← 就是主 Agent 用的那个函数
      providerName: provider.displayName,
      tools: childTools,
      unhandledErrorMode: "summarize-and-fail",
      invokeTool,
      modelTurn: createOpenAiReactModelTurn({ provider, tools: childTools }),
      systemPromptProvider: async () => {
        let runtimePrompt = "";
        try {
          runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
        } catch {
          // Runtime context is useful but must not block the model/tool loop.
        }
        return [childProfile.systemPrompt, runtimePrompt].filter(Boolean).join("\n\n");
      },
    });
  },
});
```

**`createReactAgentRunner`** ——和主 Agent 完全同一个函数。子智能体不是什么特殊的轻量执行器,它就是**上一个系列讲的那个 ReAct 循环**,一模一样的主循环、一模一样的工具调用机制、一模一样的护栏(重复调用拦截、失败熔断、证据门禁)。

三个参数不同:

| 参数 | 主 Agent | 子智能体 |
|------|---------|---------|
| `tools` | 全部 + workflow 工具 | 角色白名单过滤后的子集 |
| `systemPromptProvider` | `AGENT_SYSTEM_PROMPT` | `childProfile.systemPrompt` + 运行时上下文 |
| `unhandledErrorMode` | `"summarize-and-finish"` | `"summarize-and-fail"` |

第三个差异有意思。主 Agent 遇到没处理的错误会 **summarize-and-finish**——总结一下然后正常收尾,因为它要给用户一个答复。子智能体是 **summarize-and-fail**——标记为失败。

因为子智能体的"失败"是**有意义的信号**:它会触发 `settle(failed)`,进而触发级联取消,让整个下游停下来。如果子智能体也 finish,主 Agent 会以为它成功了,拿着一个空结论继续往下走。

`✶ 递归带来的一致性红利`
子智能体复用主 Agent 的 runner,意味着上个系列讲的所有工程护栏**自动对子智能体生效**。你不需要为子智能体重新实现一遍重复调用拦截、连续失败熔断、证据门禁。这是"用同一个抽象递归"相比"写两套执行器"最大的收益——修一个 bug,两层同时受益。

至此,子智能体已经能跑起来、有正确的权限、结论能回到主 Agent。但还有一个问题没解决:**你怎么知道一个子智能体是卡住了,还是正在干活?** 下一篇讲这个意外棘手的问题。

---

## 关于 LoopAgent

本文代码来自 [LoopAgent](https://github.com/oi12344/loopagent-vscode)。涉及的文件:

- [src/extension/agent/workflow/roleRegistry.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/roleRegistry.ts) — 四个角色的提示词与白名单
- [src/extension/agent/workflow/toolRouter.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/toolRouter.ts) — 两段式工具收窄
- [src/extension/agent/workflowOrchestrator.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflowOrchestrator.ts) — 角色解析与上下文创建
- [src/extension/model/providerRegistry.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/model/providerRegistry.ts) — 子智能体的递归构造

欢迎点个 star ⭐

**项目地址**:https://github.com/oi12344/loopagent-vscode

---

📖 上一篇:03 · 谁能跑,谁得等 ｜ 下一篇:05 · 它是卡住了,还是在干活?
