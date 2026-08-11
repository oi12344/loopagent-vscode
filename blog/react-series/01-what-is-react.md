# 01 · 一个提问,AI 是怎么"边想边做"的?

> 系列首篇。我们不碰任何术语,先从一个你我都遇到过的场景出发,把 ReAct Agent "边想边做"的直觉建立起来。源码来自开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)** ⭐。

## 先看一个"不够聪明"的 AI

假设你对一个普通的聊天 AI 说:

> "帮我看看登录超时的报错是从哪来的,顺手修一下。"

一个只会"一问一答"的模型会怎么做?它会**凭记忆猜**:"登录超时嘛,可能是数据库连接慢、可能是 token 过期、也可能是网络……你可以检查一下 XXX。"

问题很明显:**它没看过你的代码**。它不知道你项目里 `httpClient` 的超时设成了几秒,不知道 `loginService` 到底怎么抛的错。它给的是一篇正确的废话。

真正有用的助手应该像一个**坐到你工位上的同事**:先搜一下代码、打开几个文件看看、跑个测试,**看到真实情况**之后再下结论。

这个"看一眼真实世界、再决定下一步"的能力,就是 ReAct 要解决的问题。

## ReAct 三个字:Reason + Act

ReAct 是 "**Reason**ing + **Act**ing" 的缩写,直译就是**"边推理边行动"**。它的核心是一个循环:

```
想一步(Reason) → 做一件事(Act) → 看结果(Observe) → 再想一步 → ……直到能给出答案
```

把它套到刚才的场景上,一个 ReAct Agent 会这样工作:

```
🧠 想:用户说登录超时。我得先找到相关代码,搜 "login timeout" 试试。
🔧 做:调用「代码搜索」工具,query = "login timeout 登录 超时"
👀 看:搜到 3 处 —— session.ts 里 SESSION_TIMEOUT=5000;
       loginService.ts 抛「登录超时」;httpClient.ts 默认 timeout=3000ms(比会话还短!)

🧠 想:httpClient 只有 3 秒,比会话超时还短,很可疑。读一下 loginService 确认。
🔧 做:再次搜索 loginService 的处理逻辑
👀 看:确认了 —— httpClient 3 秒就 abort,被上层翻译成「登录超时」

🧠 想:根因清楚了,把 httpClient 的超时从 3000 改成 15000。
🔧 做:调用「编辑文件」工具修改
👀 看:修改成功

🧠 想:改完跑个测试验证。
🔧 做:调用「运行命令」工具:npm test -- login
👀 看:4 条测试全过

🧠 想:齐活了,可以给最终答案了。
✅ 答:根因是 httpClient 默认超时 3 秒太短……我已改成 15 秒并测试通过。
```

看到区别了吗?它**没有猜**。每一个结论都建立在"真的去查了、真的看到了"的基础上。这就是 ReAct 比"一问一答"强的地方——**它能和你的真实环境交互**。

> ✶ **一句话抓住本质**
> "一问一答"的 AI 是闭卷考试,只能靠记忆答题;ReAct Agent 是开卷 + 能做实验——它可以随时翻书(搜代码)、做实验(跑命令)、看到结果再继续。

## 那些"工具",在 LoopAgent 里长什么样

上面故事里的「代码搜索」「编辑文件」「运行命令」,在真实项目里就是一个个**工具(Tool)**。在 [LoopAgent](https://github.com/oi12344/loopagent-vscode) 的 `src/extension/agent/` 目录下,它们是一个个独立文件:

| 故事里的动作 | 真实工具文件 | 干什么 |
|------|------|------|
| 搜代码 | [`exploreCodeTool.ts`](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/exploreCodeTool.ts) | 在代码智能索引里语义搜索 |
| 读文件 | [`readFileTool.ts`](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/readFileTool.ts) | 读取指定文件内容 |
| 改文件 | [`applyEditTool.ts`](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/applyEditTool.ts) | 对文件做精确编辑 |
| 跑命令 | [`runCommandTool.ts`](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/runCommandTool.ts) | 执行 shell 命令(带审批) |
| 审查代码 | [`codeReviewTool.ts`](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/codeReviewTool.ts) | 对改动做代码审查 |
| 浏览符号 | [`browseSymbolsTool.ts`](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/browseSymbolsTool.ts) | 列出文件里的函数/类等符号 |

每个工具都遵循同一个接口约定。这是它们的"身份证"类型([reactTypes.ts:53-60](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactTypes.ts#L53-L60)):

```typescript
export type ReactAgentTool = {
  name: string;                        // 工具名,模型用它来点名调用
  description: string;                 // 描述,告诉模型"我能干嘛、什么时候用我"
  inputSchema: Record<string, unknown>;// 参数格式(JSON Schema)
  isConcurrencySafe?: (input: unknown) => boolean;  // 能否和别的工具并发跑
  invoke(invocation): string | ReactAgentToolResult | Promise<...>;  // 真正干活
};
```

`✶ Insight ─────────────────────────────────────`
注意 `description` 这个字段——它不是给人看的注释,而是**给模型看的说明书**。模型全靠每个工具的 `name` + `description` + `inputSchema` 来判断"这一步该用哪个工具、参数怎么填"。写好工具描述,几乎等于给 Agent 写好了操作手册。这也是为什么造 Agent 时,工具描述的措辞往往比工具代码本身还值得斟酌。
`─────────────────────────────────────────────────`

## 谁在驱动这个循环?

工具只是"手脚",让它们按 ReAct 节奏动起来的"大脑调度器",是 LoopAgent 里的 `reactAgentRunner`。它的主循环骨架长这样(简化自 [reactAgentRunner.ts:118](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L118)):

```typescript
for (let step = 1; step <= maxSteps; step++) {
  // 1️⃣ 问模型:这一步你想干嘛?(Reason + 决定 Act)
  const result = await modelTurn({ messages, signal, toolChoice });

  // 2️⃣ 如果模型给了最终答案 —— 循环结束
  if (result.kind === "final") {
    return result.content;
  }

  // 3️⃣ 否则模型要调工具 —— 执行它们,把结果(Observe)塞回对话
  for (const request of result.requests) {
    const output = await invokeTool(request, signal);
    messages.push({ role: "tool", content: output.content, /* ... */ });
  }
  // 4️⃣ 回到循环顶部,带着新看到的结果再想一步
}
```

就这么朴素:**问模型 → 要么收尾、要么调工具 → 把工具结果喂回去 → 再问模型**。转上几圈,一个复杂任务就被拆成了一连串"想一步做一步"的小动作。

真实代码当然比这多得多——步数上限、失败熔断、重复调用拦截、检查点保存……但**骨架就是这四步**。后面第 03 篇会把这个循环逐帧慢放。

## 小结

- 普通 AI 靠记忆猜,ReAct Agent 靠**和真实环境交互**——搜代码、读文件、跑测试,看到结果再决策;
- 核心是一个循环:**Reason(想)→ Act(做)→ Observe(看)→ 再 Reason**,直到能给出答案;
- "做"的能力来自一个个**工具**,每个工具用 `name/description/inputSchema` 向模型自我介绍;
- 驱动循环的是 `reactAgentRunner`,骨架就是"问模型 → 调工具 → 回填结果 → 再问"。

下一篇我们要挖一个更尖锐的问题:ReAct 原论文让模型输出 `Thought:/Action:/Observation:` 这样的**文本标签**,而 LoopAgent 一个标签都没用——为什么?文本范式到底哪里疼?

---

📖 下一篇:02 · 经典 ReAct 的"文本标签之痛"

> 本文源码来自开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)**,一个 VS Code 里的 AI 编码 Agent。觉得有用点个 Star ⭐ → https://github.com/oi12344/loopagent-vscode
