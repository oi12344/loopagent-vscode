# 04 · 一步发多个工具:多 tool_call 的格式

> 系列第四篇,源码密集篇。经典 ReAct 一次只能做一个动作,而函数调用式可以**一步同时发多个工具**。这篇看这些工具调用的流式碎片如何靠 `index` 归位、如何并发执行、如何回填历史。源码来自 [LoopAgent](https://github.com/oi12344/loopagent-vscode) ⭐。

## 为什么要一步多工具

回到登录超时的例子。有时候模型的最优策略是**同时搜两个关键词**:"login" 和 "session" 分头查,不用等第一个搜完再搜第二个。经典文本范式的 `Action:` 天生一次一个,而函数调用式的 `tool_calls` 本质是**一个数组**,天然支持一步多个。

多个 tool_call 的格式,要分**四个层面**看——它们是同一批数据在不同阶段的形态。

---

## 层面一:线上流式格式(wire format)

模型**不会**一次性吐出完整的多个 tool_call,而是**逐字符流式**下发。LoopAgent 把每个流片段抽象成 `toolCallDelta` 事件([types.ts:65-71](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/model/types.ts#L65-L71)):

```typescript
| {
    type: "toolCallDelta";
    index: number;        // ★ 关键:第几个 tool_call(0,1,2...)
    id?: string;          // 调用 id,只在该 call 的首片段出现
    name?: string;        // 函数名,通常只在首片段出现
    argumentsDelta?: string;  // JSON 参数的一小段,会分多次到达
  }
```

`✶ Insight ─────────────────────────────────────`
**`index` 是区分多个 tool_call 的唯一凭据。** 底层 SSE 流把 N 个 tool_call 的碎片**交错**发下来——`index:0` 的名字、`index:1` 的名字、`index:0` 的参数片段、`index:1` 的参数片段……全靠 `index` 才能把碎片归位到正确的那个调用。这是 OpenAI Chat Completions 流式 `tool_calls` 协议的标准设计。
`─────────────────────────────────────────────────`

假设模型决定同时搜 "login" 和 "session",实际到达的事件流大致这样(简化):

```
{ type:"toolCallDelta", index:0, id:"call_a", name:"explore_code" }
{ type:"toolCallDelta", index:0, argumentsDelta:"{\"query\":" }
{ type:"toolCallDelta", index:1, id:"call_b", name:"explore_code" }   ← 第二个开始交错进来
{ type:"toolCallDelta", index:0, argumentsDelta:"\"login\"}" }
{ type:"toolCallDelta", index:1, argumentsDelta:"{\"query\":\"session\"}" }
{ type:"finishReason",  reason:"tool_calls" }                          ← 收尾信号
```

注意 `index:0` 和 `index:1` 的碎片是**穿插**到达的。没有 `index`,你根本没法把 `"login"}` 拼回给 call_a 而不是 call_b。

---

## 层面二:组装态(按 index 聚合的 Map)

[openAiReactModelTurn.ts:25,52-58](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L25-L58) 用一个 `Map<number, PendingToolCall>` 按 `index` 累积、拼接:

```typescript
const pendingCalls = new Map<number, PendingToolCall>();
// ...
const pending = pendingCalls.get(event.index) ?? { name: "", arguments: "" };
pendingCalls.set(event.index, {
  id: event.id ?? pending.id,                           // id 取首次出现的
  name: pending.name + (event.name ?? ""),              // 名字累加拼接
  arguments: pending.arguments + (event.argumentsDelta ?? ""),  // 参数字符串累加
});
```

上面那串事件跑完,`pendingCalls` 变成:

```
{
  0 => { id:"call_a", name:"explore_code", arguments:'{"query":"login"}' },
  1 => { id:"call_b", name:"explore_code", arguments:'{"query":"session"}' }
}
```

`arguments` 此刻还是**字符串**(拼出来的 JSON 文本),尚未解析。

---

## 层面三:结构化态(runner 拿到的形态)

`finishReason === "tool_calls"` 且 `pendingCalls.size > 0`,于是走 `createToolRequests`([openAiReactModelTurn.ts:100-145](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L100-L145))。它按 index 排序遍历,产出**两份并行的数组**。

先看它的完整性校验([openAiReactModelTurn.ts:105-116](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L105-L116)):

```typescript
for (const [, pending] of [...pendingCalls.entries()].sort(([l], [r]) => l - r)) {
  if (!pending.id)   throw new Error("Tool call did not include an id");
  if (!pending.name) throw new Error(`Tool call ${pending.id} did not include a name`);
  if (ids.has(pending.id)) throw new Error(`Duplicate tool call id: ${pending.id}`);
  ids.add(pending.id);

  let input: unknown;
  let parseError: string | undefined;
  try {
    input = JSON.parse(pending.arguments);   // ← 每个 call 各自解析
  } catch {
    parseError = `Invalid JSON arguments for tool ${pending.name}`;
  }
  // ...
}
```

缺 `id`、缺 `name`、`id` 重复都会 `throw`,保证下发的每个 call 干净可执行。而 JSON 解析失败只影响**该 call 自己**(记一个 `parseError`),不牵连兄弟 call。

产出的两份数组:

**① `ModelToolCall[]`**——存进消息历史用([types.ts:12-19](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/model/types.ts#L12-L19)):

```typescript
[
  { id:"call_a", type:"function", function:{ name:"explore_code", arguments:'{"query":"login"}' } },
  { id:"call_b", type:"function", function:{ name:"explore_code", arguments:'{"query":"session"}' } }
]
```

`arguments` 保持字符串——这是协议原样。

**② `ReactAgentToolRequest[]`**——runner 执行用([reactTypes.ts:24-30](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactTypes.ts#L24-L30)):

```typescript
[
  { id:"call_a", name:"explore_code", rawArguments:'{"query":"login"}',   input:{query:"login"} },
  { id:"call_b", name:"explore_code", rawArguments:'{"query":"session"}', input:{query:"session"} }
]
```

`input` 是 `JSON.parse` 后的对象,runner 直接拿来用。

`✶ Insight ─────────────────────────────────────`
这里有个刻意的**双份设计**:`ModelToolCall`(带 `type:"function"`、`arguments` 为字符串)要**原样回写进 assistant 消息历史**,下一轮发给模型时它才认得自己上次调了什么,必须符合协议格式;`ReactAgentToolRequest`(带解析后的 `input`)是给 runner **本地执行**用的。同一次调用,一个面向"和模型对话的协议",一个面向"本地工具执行",职责分离。
`─────────────────────────────────────────────────`

最终返回给 runner 的对象([openAiReactModelTurn.ts:139-144](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L139-L144)):

```typescript
return {
  kind: "toolRequests",
  ...(reasoning ? { reasoning } : {}),
  assistantMessage: { role: "assistant", content: "", toolCalls },  // ← 含完整 ModelToolCall[]
  requests,                                                          // ← 两个待执行请求
};
```

---

## 层面四:runner 如何消费这批多 call

回到 [reactAgentRunner.ts:184-266](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L184-L266)。

**① 一条 assistant 消息挂 N 个 call**

```typescript
messages.push(result.assistantMessage);  // 一条 assistant,携带 [call_a, call_b] 两个 call
```

**② 分批,并发安全的并行跑**([reactAgentRunner.ts:229-231](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L229-L231)):

```typescript
const outcomes = batch.concurrent
  ? await Promise.all(batch.requests.map(({ request }) => invoke(request)))  // 并行
  : [await invoke(batch.requests[0]!.request)];                             // 串行
```

是否可并发由工具自己声明——`ReactAgentTool` 的 `isConcurrencySafe`([reactTypes.ts:58](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactTypes.ts#L58))。两个 `explore_code` 都是只读搜索,可以并行;但如果其中一个是 `apply_edit`(要写文件),就会被排到串行批次里,避免并发写冲突。

`✶ Insight ─────────────────────────────────────`
这是函数调用式相对经典范式一个"白捡"的性能红利:"同时 grep 三个关键词"可以一轮打完,墙钟时间 = 最慢那个工具的耗时,而不是三个之和。文本标签范式要实现这个,得自己发明多动作的文本语法并解析,又把可靠性拉回坑里(见第 02 篇)。
`─────────────────────────────────────────────────`

**③ 每个 call 各自回填一条 tool 消息**([reactAgentRunner.ts:237-266](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L237-L266)):

```typescript
for (const [index, { request, call }] of batch.requests.entries()) {
  const outcome = outcomes[index]!;
  // ... 更新记分板、发前端事件 ...
  messages.push({
    role: "tool",
    requestId: request.id,   // ← 靠 id 对应回各自的 call
    name: request.name,
    content: outcome.content,
  });
}
```

回填后,历史里的形态是:

```
assistant(toolCalls: [call_a, call_b])           ← 一条 assistant,两个 call
tool(requestId:"call_a", content:"login 搜索结果...")    ← 各自一条 tool 消息
tool(requestId:"call_b", content:"session 搜索结果...")
```

`✶ Insight ─────────────────────────────────────`
**"一条 assistant + N 条 tool" 是多 call 在历史里的标准形态。** 协议硬性要求:每个 tool_call 都必须有一条 `toolCallId` 匹配的 tool 消息回应——少一条,下一轮请求就是非法的(服务端会报"有未回应的 tool_call")。这就是为什么 runner 对批次里每个 call **无论成败都要** push 一条 tool 消息:成功填结果,失败填 `"Tool error: ..."`,一个都不能漏。
`─────────────────────────────────────────────────`

---

## 一张图串起四个层面

```
wire 层    交错的 toolCallDelta 流 ──靠 index 区分──┐
                                                   ▼
组装层    Map<index, {id, name, arguments}>  按 index 拼接
                                                   ▼
结构层    ModelToolCall[]        (协议原样,arguments 为字符串)
          ReactAgentToolRequest[] (解析出 input,可能带 parseError)
                                                   ▼
历史层    assistant(toolCalls:[N个]) + N 条 tool(requestId 对应)
```

全程没有任何"第一个动作/第二个动作"的文本标签,多 call 的边界完全由 `index` 和 `id` 这两个协议字段划定。

## 小结

- 多个 tool_call 本质是**一个数组**,经历四层形态:wire 流 → Map 组装 → 双份结构化数组 → 历史消息;
- `index` 负责在**流式碎片交错**时把它们归位;`id` 负责在**回填结果**时把 observation 挂回对应 action;
- 并发安全的工具可 `Promise.all` 并行跑,由工具的 `isConcurrencySafe` 声明;
- 铁律:每个 call 无论成败都要回填一条 `role:"tool"` 消息,否则下一轮请求非法。

最后一篇,我们看那些把"能跑的 demo"变成"能用的产品"的工程护栏:重复调用拦截、连续失败熔断、证据门禁、倒计时收尾。

---

📖 上一篇:03 · 慢放一次完整的 ReAct 循环 ｜ 下一篇:05 · 让 Agent 不翻车的工程护栏

> 本文源码来自开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)** ⭐ → https://github.com/oi12344/loopagent-vscode
