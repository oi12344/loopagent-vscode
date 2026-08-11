# 02 · 经典 ReAct 的"文本标签之痛"

> 系列第二篇。上一篇建立了 ReAct 的直觉,这一篇要问一个尖锐的问题:ReAct 原论文让模型吐 `Thought:/Action:/Observation:` 文本标签,而 [LoopAgent](https://github.com/oi12344/loopagent-vscode) 一个标签都没用——为什么?⭐

## 经典 ReAct 长什么样

2022 年那篇 ReAct 论文(Yao et al.)里,Agent 的工作方式是让模型在**一整段文本**里,按固定格式吐出交替的推理和动作:

```
Thought: 我需要查一下登录超时相关的代码
Action: search[login timeout]
Observation: 找到 3 处:session.ts、loginService.ts、httpClient.ts
Thought: httpClient 的超时只有 3 秒,可疑,读一下细节
Action: read[loginService.ts]
Observation: ECONNABORTED 被翻译成了"登录超时"
Thought: 根因清楚了
Final Answer: 根因是 httpClient 超时太短……
```

然后程序这边写一个**解析器**,用正则去这段文本里抠东西:找到 `Action:` 那一行,把 `search[...]` 里的动作名和参数切出来,去执行;执行完把结果拼成 `Observation: ...` 再接到文本后面,重新喂给模型。

整个循环,**靠的是模型老老实实按格式写字**。这就是问题的起点。

## 痛点一:模型不一定按格式写字

模型是概率生成的,它**没有义务**严格遵守你在 prompt 里定的格式。真实世界里会发生:

- 模型把 `Action:` 写成中文"动作:",正则匹配不到;
- 参数里带了引号或换行 —— `Action: edit[file="a.ts", content="line1\nline2"]` —— 括号/引号配对被打乱,切出来的参数是错的;
- 模型一时兴起把 `Thought` 和 `Action` 顺序写反,或一段里塞了两个 `Action:`;
- 模型忘了写 `Final Answer:`,程序永远等不到结束信号,循环停不下来。

**任何一种,解析器就地失败,整局崩溃。** 而且这种失败很难向模型"说清楚",因为你连它到底哪里写错了都难结构化地定位。

`✶ Insight ─────────────────────────────────────`
这不是"模型不够强"的问题,再强的模型也是概率生成,总有小概率跑偏。问题在于**架构把可靠性押在了"模型的文本纪律"上**——而这是整个系统里最不可控的一环。工程上,把关键正确性依赖压在一个概率组件的自觉性上,是危险的设计。
`─────────────────────────────────────────────────`

## 解法:用模型的"原生工具调用"替代文本标签

2023 年之后,OpenAI 等把**工具调用(function calling / tool calling)**做进了模型协议本身。模型不再需要在正文里手写 `Action: search[...]`,而是通过一个**结构化的协议字段**告诉你"我要调用哪个函数、参数是什么"。

LoopAgent 走的就是这条路。看它接收模型输出的地方([openAiReactModelTurn.ts:52-58](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L52-L58)):

```typescript
} else if (event.type === "toolCallDelta") {
  const pending = pendingCalls.get(event.index) ?? { name: "", arguments: "" };
  pendingCalls.set(event.index, {
    id: event.id ?? pending.id,
    name: pending.name + (event.name ?? ""),
    arguments: pending.arguments + (event.argumentsDelta ?? ""),
  });
}
```

这里消费的 `toolCallDelta` 是**协议层的结构化事件**,动作是 `{ id, name, arguments }` 这样的对象,`arguments` 是 JSON 字符串。程序不再去正文里正则抠 `Action:`,而是直接读协议字段。

Thought 和 Observation 也各自有了专门的"通道",不再混在正文里:

| ReAct 概念 | 经典文本范式 | LoopAgent(函数调用式) |
|-----------|------------|----------------------|
| **Thought** | 正文里的 `Thought:` 行 | 模型的 `reasoning` 通道([reactTypes.ts:14](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactTypes.ts#L14)) |
| **Action** | 正文里的 `Action:`,正则解析 | 原生 `tool_calls`(结构化 JSON) |
| **Observation** | 拼进正文的 `Observation:` 文本 | 独立的 `role:"tool"` 消息 |

## 优势一:解析失败从"全局崩溃"降级为"局部可恢复"

即使模型把参数写成了非法 JSON,函数调用式也不会崩。看解析处([openAiReactModelTurn.ts:117-123](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L117-L123)):

```typescript
let input: unknown;
let parseError: string | undefined;
try {
  input = JSON.parse(pending.arguments);
} catch {
  parseError = `Invalid JSON arguments for tool ${pending.name}`;  // 只记一个错,不 throw
}
```

这个 `parseError` 会被带到 runner,变成一条喂回模型的**错误消息**([reactAgentRunner.ts:208-210](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L208-L210)):

```typescript
if (toolRequest.parseError) {
  return { content: `Tool error: ${toolRequest.parseError}`, succeeded: false, /* ... */ };
}
```

模型下一轮就能看到"哦我上次参数写错了",自我纠正。**经典文本范式里,一次解析失败往往是不可恢复的**——你甚至难以结构化地告诉模型错在哪。

## 优势二:Observation 和 Action 强绑定,归因清晰

经典范式把工具结果拼成 `Observation: ...` 的普通文本,和模型自己的 `Thought:` 混在同一段里,模型分不清"哪句是我推理的、哪句是环境返回的"。上下文一长,幻觉风险陡增。

LoopAgent 用独立的 `role:"tool"` 消息回填,还带 `requestId`([reactAgentRunner.ts:261-266](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L261-L266)):

```typescript
messages.push({
  role: "tool",
  requestId: request.id,   // ← 精确挂回发起它的那次 action
  name: request.name,
  content,
});
```

每条 observation 通过 `requestId` 精确对应到发起它的那次 action。模型天然知道"这是 call_a1 那次搜索的结果",角色边界由**消息结构**划定,而不是靠文本约定。

## 优势三:停机判定从"文本约定"变成"协议信号"

"什么时候算说完了"——两种范式的依据完全不同:

- **经典**:等模型吐 `Final Answer:` 这行文本,正则命中才停。模型忘写标签 = 停不下来。
- **LoopAgent**:看这一轮模型**有没有发 tool_calls**。有就是继续行动,没有且有正文就是最终答案([openAiReactModelTurn.ts:76-81](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L76-L81)):

```typescript
if (content.length > 0) {
  if (toolChoice === "required" || typeof toolChoice === "object") {
    throw new Error("Model did not call a required tool");
  }
  return { kind: "final", content, ...(reasoning ? { reasoning } : {}) };  // ← 没调工具 + 有正文 = 收尾
}
```

判定依据从"模型的文本自觉"变成了 `finishReason` 这个协议字段,鲁棒性质变。

`✶ Insight ─────────────────────────────────────`
在可靠的停机信号之上,LoopAgent 还能做经典范式难做的**倒计时收尾**:临近步数上限时,把 `toolChoice` 强制设成 `"none"`,从协议层**禁掉工具**逼模型给答案([reactAgentRunner.ts:132](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L132))。文本范式里你只能在 prompt 里"求"它收尾,约束力弱得多。这个机制第 05 篇会细讲。
`─────────────────────────────────────────────────`

## 但要诚实:函数调用式也有代价

天下没有免费的优势。函数调用式换来一个硬约束:**它绑定了支持工具调用协议的模型**。文件名 `openAiReactModelTurn.ts` 就暴露了这层依赖——它消费的是 OpenAI 兼容的流式工具调用协议(DeepSeek 等也兼容)。

面对只能吐纯文本的本地小模型、老式补全接口,经典文本标签 ReAct 反而是**唯一可行**的路——它只要求模型会输出文本。

好在 LoopAgent 把"模型这一回合怎么进行"抽象成了一个接口 `ReactModelTurn`([reactTypes.ts:75](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactTypes.ts#L75)):

```typescript
export type ReactModelTurn = (input: {
  messages: ReactAgentMessage[];
  signal: AbortSignal;
  toolChoice?: ModelToolChoice;
}) => Promise<ReactModelTurnResult>;
```

`openAiReactModelTurn` 只是它的一个**实现**。将来要接一个只吃文本的模型,再写一个"文本解析版"的 `ReactModelTurn` 实现即可,runner 主循环一行都不用动。这是把"协议依赖"隔离在边界层的好设计。

## 小结

| 维度 | 经典文本标签 | 函数调用式(LoopAgent) |
|------|------|------|
| 动作格式 | 模型自觉写 `Action:`,正则解析 | 原生 `tool_calls`,协议保证 |
| 解析失败 | 常导致整局崩溃 | 降级为可恢复的错误消息 |
| Observation 归因 | 混在正文,边界模糊 | `role:"tool"` + `requestId` 强绑定 |
| 停机判定 | 靠 `Final Answer:` 文本 | 靠 `finishReason` 协议信号 |
| 模型要求 | 只要会吐文本(更通用) | 需支持工具调用协议 |

一句话:**函数调用式在可靠性、归因、停机三个维度全面胜出,代价是绑定工具调用协议;经典范式只在"模型不支持工具调用"时才更优。**

下一篇,我们把 LoopAgent 的 ReAct 主循环**逐帧慢放**,从用户提问到最终答案,看每一条消息怎么在 system/user/assistant/tool 之间流动。

---

📖 上一篇:01 · 一个提问,AI 是怎么"边想边做"的? ｜ 下一篇:03 · 慢放一次完整的 ReAct 循环

> 本文源码来自开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)** ⭐ → https://github.com/oi12344/loopagent-vscode
