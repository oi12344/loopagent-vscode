# 03 · 慢放一次完整的 ReAct 循环

> 系列第三篇,也是核心篇。我们把 [LoopAgent](https://github.com/oi12344/loopagent-vscode) 的 `reactAgentRunner` 主循环拆成 6 帧,逐帧看消息如何流动。建议对照仓库 `src/extension/agent/reactAgentRunner.ts` 一起读。⭐

## 场景

沿用第 01 篇的例子。用户输入:

> **"帮我看看登录超时的报错是从哪来的,顺手修一下。"**

这条 task 进入 [reactAgentRunner.ts:47](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L47) 的 `run(request)`,循环开始。

---

## 第 0 帧:开场布置

循环开始前,runner 先搭好这一局的"棋盘"([reactAgentRunner.ts:61-102](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L61-L102)):

```
messages = [
  { role: "system", content: "<系统提示:你是代码助手,可用工具 explore_code / apply_edit / run_command...>" },
  { role: "user",   content: "帮我看看登录超时的报错是从哪来的,顺手修一下。" }
]
```

同时初始化几个"记分板":

```typescript
const successfulTools = new Set<string>();     // 哪些工具成功跑过(证据门禁用)
const succeededCalls  = new Map<string, string>(); // 签名 → 结果摘要(拦重复调用用)
const toolFailures    = new Map<string, number>(); // 工具名 → 连续失败数(熔断用)
```

这三个记分板是第 05 篇工程护栏的主角,先记住它们的存在。

`✶ Insight ─────────────────────────────────────`
注意这里就和经典 ReAct 分道扬镳了:经典范式的 system prompt 里要塞一大段格式说明("你必须按 Thought:/Action: 输出"),而这里的 system prompt 只描述工具**能干什么**,格式约束交给协议,不靠文本纪律。prompt 更短、更聚焦于任务本身。
`─────────────────────────────────────────────────`

---

## 第 1 帧:Step 1 —— 模型第一次"想 + 做"

进入主循环 [reactAgentRunner.ts:118](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L118):

```typescript
for (let step = initialStep; step <= maxSteps + 1 + 2; step++) {
  const isFinalAnswerStep = step > maxSteps;
  if (signal.aborted) return;

  yield { type: "assistantThinking", runId, message: `Planning step ${step}` };
  await saveCheckpoint(step);
  // ...
  const result = await modelTurn({ messages, signal, toolChoice });
```

先给前端发个"Planning step 1"的进度信号,存个检查点(断点续跑用),然后调 `modelTurn` 把整盘 messages 丢给模型。模型这一轮返回:

**① Thought —— 走 `reasoning` 通道**

```
reasoning = "用户说登录超时报错。我得先定位相关代码,
             'login''timeout' 这些词是好线索,先全局搜一把。"
```

这段在 [openAiReactModelTurn.ts:48](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L48) 由 `reasoningDelta` 事件累积,回到 runner 后通过 `assistantReasoningDelta` 推给前端([reactAgentRunner.ts:143-145](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L143-L145))——用户看到的是灰色的"思考中"文字,**不是** `Thought:` 这行字面文本。

**② Action —— 走原生 `tool_calls`**

模型没给最终答案,而是发起工具调用。`finishReason` 为 `"tool_calls"`,`modelTurn` 返回:

```
{ kind: "toolRequests",
  reasoning,
  assistantMessage: { role:"assistant", content:"", toolCalls:[explore_code] },
  requests: [ { id:"call_a1", name:"explore_code", input:{query:"login timeout 登录 超时"} } ] }
```

---

## 第 2 帧:Step 1 —— 执行 Action,拿到 Observation

回到 runner,`result.kind === "toolRequests"`,走到 [reactAgentRunner.ts:184](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L184):

**① 先把模型的决策入历史**

```typescript
messages.push(result.assistantMessage);  // 记录"我决定调 explore_code"
```

**② 通知前端"工具开始跑"**([reactAgentRunner.ts:191-197](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L191-L197)):

```typescript
yield {
  type: "toolCallStarted",
  runId,
  callId: `${step}-${call}`,
  toolName: request.name,
  input: getToolInputPreview(request.name, request.input),
};
```

界面上此刻冒出一张卡片:🔍 `explore_code` 运行中。

**③ 真正执行工具**——在 `invoke` 里([reactAgentRunner.ts:204-227](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L204-L227)),先过三道闸(未知工具?参数解析失败?重复调用?),都通过后真调 `invokeTool`,返回:

```
content = "找到 3 处:session.ts:88 SESSION_TIMEOUT=5000;
           loginService.ts:142 抛「登录超时」;
           httpClient.ts:30 默认 request timeout=3000ms(比会话超时还短!)"
```

**④ 这段结果就是 Observation**——通过 `role:"tool"` 消息回填([reactAgentRunner.ts:261-266](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L261-L266)),同时更新记分板([reactAgentRunner.ts:237-252](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L237-L252)):

```typescript
if (outcome.succeeded && outcome.productive) successfulTools.add(request.name);
// ...
if (outcome.succeeded) {
  succeededCalls.set(`${request.name}:${request.rawArguments}`, content.slice(0, 200));
  toolFailures.set(request.name, 0);
  evidence.push(...outcome.evidence);
}
```

前端卡片变成 ✅ 完成。此刻 `messages` 长这样:

```
[ system, user,
  assistant(toolCalls: explore_code),     ← Action
  tool(explore_code → "找到 3 处...") ]    ← Observation
```

`✶ Insight ─────────────────────────────────────`
关键区别:经典 ReAct 把 Observation 当成 `Observation: 找到3处...` 的普通文本拼进上下文,模型分不清"这是我说的"还是"环境告诉我的"。这里用独立的 `role:"tool"` + `requestId` 把 observation 和它对应的 action **强绑定**,模型天然知道"这是 call_a1 那次搜索的返回",归因清晰。
`─────────────────────────────────────────────────`

---

## 第 3 帧:Step 2 —— 第二轮"想 + 做"(读细节)

循环回到 [reactAgentRunner.ts:118](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L118) 顶部,step=2,再次 `modelTurn(messages)`。模型这次**带着上一轮的 Observation** 继续:

**Thought**:"httpClient 的 timeout=3000ms 比会话 5000ms 还短,很可疑——请求还没超时会话就先断了?读一下 loginService.ts:142 附近确认。"

**Action**:再调 `explore_code`,`input = {query:"loginService.ts login timeout handling"}`,`id="call_b2"`。

执行同前,回填 Observation:

```
tool(explore_code → "loginService 第140行: try{ await http.post('/login') }
      catch(e){ if(e.code==='ECONNABORTED') throw '登录超时' }
      —— 即:httpClient 的 3s 超时被误报成「登录超时」")
```

现在模型手里线索齐了:**根因是 httpClient 默认 3000ms 太短,请求还没完成就 abort,被上层翻译成「登录超时」。**

---

## 第 4 帧:Step 3 —— 动手修

step=3,模型决定行动:

**Thought**:"根因清楚了,把 httpClient.ts:30 的默认超时从 3000 调到 15000。"

**Action**:调 `apply_edit`:

```json
{ "id":"call_c3", "name":"apply_edit",
  "arguments":"{\"path\":\"httpClient.ts\",\"oldStr\":\"timeout: 3000\",\"newStr\":\"timeout: 15000\"}" }
```

**Observation**:`tool(apply_edit → "已修改 httpClient.ts:30: timeout 3000 → 15000")`,`successfulTools` 加入 `apply_edit`。

> **如果这一步失败呢?** 比如 `oldStr` 没匹配上,`invokeTool` 抛错,被 [reactAgentRunner.ts:224-226](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L224-L226) 捕获成 `{content:"Tool error:...", succeeded:false}`,`toolFailures["apply_edit"]` 累加。同一工具**连续失败 3 次**就触发熔断 [reactAgentRunner.ts:255-257](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L255-L257) 直接终止,防止模型在死路上无限打转。这是经典 ReAct 里没有的护栏,第 05 篇细讲。

---

## 第 5 帧:Step 4 —— 验证

step=4,模型追加一个 `run_command` 跑测试:

**Action**:`{ name:"run_command", arguments:"{\"command\":\"npm test -- login\"}" }`

**Observation**:`tool(run_command → "PASS login.test.ts (4 passed)")`

一个成熟的 Agent 不会改完就宣布胜利——它会**自己验证**。这一步是不是必需,由模型根据任务判断。

---

## 第 6 帧:Step 5 —— 给出最终答案(循环出口)

step=5,`modelTurn` 这次**不再发 tool_calls**,而是返回纯文本([openAiReactModelTurn.ts:76-81](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/openAiReactModelTurn.ts#L76-L81)):

```
{ kind: "final", content: "根因找到了:httpClient 的默认请求超时是 3000ms,
   比会话超时(5000ms)还短,请求还没完成 http 层就 abort,被 loginService 误报成
   「登录超时」。我已把默认超时改成 15000ms,并跑了 login 相关测试,4 条全过。" }
```

runner 在 [reactAgentRunner.ts:147](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L147) 命中 `result.kind === "final"`,做最后一道**证据门禁**检查([reactAgentRunner.ts:148-156](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L148-L156)):看必需工具是否都成功跑过。没缺,于是收尾:

```typescript
yield { type: "assistantDelta", runId, content: result.content };   // 用户看到回答正文
yield { type: "assistantFinished", runId };
yield { type: "runFinished", runId };
status = "completed";
finalContent = result.content;
return;   // 循环彻底结束
```

`✶ Insight ─────────────────────────────────────`
"何时停",两种范式的判定点完全不同:
- **经典 ReAct**:靠模型输出 `Final Answer:` 文本标签,正则匹配到才停。
- **LoopAgent**:靠模型这一轮**有没有发 tool_calls**——发了是继续,没发且有正文是 `final`。判定依据从"文本约定"变成"协议信号"。
- **兜底**:模型磨蹭到 `maxSteps`(默认 20)还不收尾,[reactAgentRunner.ts:132](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L132) 会强制把 `toolChoice` 设为 `"none"` 禁掉工具逼它给答案;再不给就 [reactAgentRunner.ts:272](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L272) 抛 "Model did not produce a final answer"。
`─────────────────────────────────────────────────`

---

## 把 6 帧连起来看(消息流全景)

```
messages 最终演化:
┌─ system   系统提示 + 工具清单
├─ user     "帮我看登录超时报错,顺手修一下"
│
│  ═══ Step 1 ═══
├─ assistant  [reasoning:"先全局搜"] toolCalls: explore_code(login timeout)   ← Reason+Act
├─ tool       explore_code → "找到3处: session/loginService/httpClient"        ← Observe
│
│  ═══ Step 2 ═══
├─ assistant  [reasoning:"httpClient 3s 太短,读细节"] toolCalls: explore_code   ← Reason+Act
├─ tool       explore_code → "ECONNABORTED 被翻译成「登录超时」"                 ← Observe
│
│  ═══ Step 3 ═══
├─ assistant  [reasoning:"改超时 3000→15000"] toolCalls: apply_edit            ← Reason+Act
├─ tool       apply_edit → "已修改 httpClient.ts:30"                            ← Observe
│
│  ═══ Step 4 ═══
├─ assistant  toolCalls: run_command(npm test)                                ← Act
├─ tool       run_command → "4 passed"                                         ← Observe
│
│  ═══ Step 5 ═══
└─ assistant  (无 toolCalls) content:"根因是...已修复并测试通过" → kind:"final" ← 出口
```

对照经典范式:同一个过程会是模型**一大段自由文本**里交替出现 `Thought:` / `Action: explore_code[...]` / `Observation: ...`,runner 一行行正则拆解。而这里,每一段推理、每一次动作、每一个结果都落在结构化的消息槽位里。

## 小结

- ReAct 主循环的骨架就是**"问模型 → 要么收尾、要么调工具 → 回填结果 → 再问"**,转几圈解决复杂任务;
- Thought 走 `reasoning`、Action 走 `toolCalls`、Observation 走 `role:"tool"` 消息,全程无文本标签;
- 每一步都存检查点(断点续跑)、更新三个记分板(证据/去重/熔断);
- 收尾靠"这轮没发 tool_calls"的协议信号,外加"倒计时强制收尾"兜底。

到这里,单个工具的循环讲透了。下一篇进入更硬核的细节:模型**一步同时发多个工具**时,那些流式碎片是怎么靠 `index` 归位、怎么并发执行、怎么回填历史的。

---

📖 上一篇:02 · 经典 ReAct 的"文本标签之痛" ｜ 下一篇:04 · 一步发多个工具:多 tool_call 的格式

> 本文源码来自开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)** ⭐ → https://github.com/oi12344/loopagent-vscode
