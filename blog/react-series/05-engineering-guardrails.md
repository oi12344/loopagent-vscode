# 05 · 让 Agent 不翻车的工程护栏

> 系列终篇。前四篇把 ReAct 循环讲透了。但"能跑的 demo"和"能用的产品"之间,隔着一堆护栏。这一篇看 [LoopAgent](https://github.com/oi12344/loopagent-vscode) 怎么防止 Agent 死循环、烧钱、幻觉、停不下来。⭐

## demo 会翻车的四种方式

你自己写过一个 ReAct 循环就会知道,裸循环在真实使用里很快翻车:

1. **鬼打墙**:模型用一模一样的参数反复调同一个工具,原地转圈烧 token;
2. **撞南墙**:某个工具一直失败(文件不存在、命令报错),模型不死心一直重试;
3. **睁眼说瞎话**:模型没真正查过代码,就"编"一个答案出来;
4. **停不下来**:模型迟迟不给最终答案,循环无限进行。

LoopAgent 对这四种翻车,各有一道护栏。它们都挂在第 03 篇提到的三个"记分板"上。先回顾这三个记分板([reactAgentRunner.ts:66-69](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L66-L69)):

```typescript
const successfulTools = new Set<string>();          // 哪些工具成功跑过 → 证据门禁
const succeededCalls  = new Map<string, string>();  // 签名 → 结果摘要 → 去重
const toolFailures    = new Map<string, number>();  // 工具名 → 连续失败数 → 熔断
```

---

## 护栏一:重复调用拦截(治"鬼打墙")

模型有时会用**完全相同的参数**反复调一个工具——比如同一个查询搜了三遍。LoopAgent 用"工具名 + 原始参数"当签名缓存结果,命中就拦回去([reactAgentRunner.ts:212-220](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L212-L220)):

```typescript
const cached = succeededCalls.get(`${toolRequest.name}:${toolRequest.rawArguments}`);
if (cached !== undefined) {
  return {
    content: `重复调用:已用相同参数调用过 ${toolRequest.name},上次结果:${cached}。请改变查询或给出最终答案。`,
    succeeded: false,
    productive: false,
    evidence: [],
  };
}
```

注意拦截消息的措辞——它不只是说"别重复",还**告诉模型上次的结果**,并给出两条明确出路:"改变查询"或"给出最终答案"。这是在**引导**模型走出循环,而不是单纯报错。

`✶ Insight ─────────────────────────────────────`
护栏返回的错误消息是**写给模型看的 prompt**,不是写给日志的。好的护栏消息要包含三要素:发生了什么(重复了)、当前状态(上次结果是什么)、下一步该怎么办(改查询或收尾)。把护栏当成一次微型的"再提示",Agent 的自愈能力会强很多。
`─────────────────────────────────────────────────`

---

## 护栏二:连续失败熔断(治"撞南墙")

某个工具连续失败时,继续重试只是浪费。LoopAgent 按工具名累计连续失败数,达到阈值就终止整个运行([reactAgentRunner.ts:10](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L10) 定义阈值,[reactAgentRunner.ts:253-258](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L253-L258) 执行):

```typescript
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
// ...
} else {
  const failures = (toolFailures.get(request.name) ?? 0) + 1;
  toolFailures.set(request.name, failures);
  if (failures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
    throw new Error(`工具 ${request.name} 连续失败 ${failures} 次,终止运行`);
  }
}
```

关键是"**连续**"——成功一次就清零([reactAgentRunner.ts:251](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L251) `toolFailures.set(request.name, 0)`)。所以偶尔失败一次不会误伤,只有真正"卡死在一个工具上"才熔断。

---

## 护栏三:证据门禁(治"睁眼说瞎话")

这是最巧妙的一道。它要解决的问题是:**模型不能没真正查过,就编一个答案。**

机制分两半。第一半,工具可以标记自己这次"跑成功了但没查到东西"——`ReactAgentToolResult` 的 `productive` 字段([reactTypes.ts:42-51](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactTypes.ts#L42-L51)):

```typescript
export type ReactAgentToolResult = {
  content: string;
  evidence: MemoryEvidence[];
  /** 默认 true。工具在"调用成功但没查到有用信息"时设为 false ——
   * 比如搜索没命中。这与 succeeded 不同:一次无收获的调用不是失败
   * (不该触发失败重试或熔断),但也不能算作证据。 */
  productive?: boolean;
};
```

第二半,只有**既成功、又有收获**的调用,才被记入"证据"([reactAgentRunner.ts:240-241](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L240-L241)):

```typescript
if (outcome.succeeded && outcome.productive) successfulTools.add(request.name);
```

然后在模型想给最终答案时,做一道门禁([reactAgentRunner.ts:147-156](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L147-L156)):

```typescript
if (result.kind === "final") {
  const missingTools = getMissingRequirements(requiredToolNames, requiredAnyOfToolNames, successfulTools);
  if (missingTools.length > 0) {
    if (requiredToolRetries >= 2) {
      throw new Error(`Required tools were not called successfully: ${missingTools.join(", ")}`);
    }
    requiredToolRetries++;
    messages.push({ role: "user", content: `Before finishing, call required tool(s): ${missingTools.join(", ")}.` });
    continue;   // ← 打回去,逼它先真的查一下
  }
  // ... 才允许收尾
}
```

`✶ Insight ─────────────────────────────────────`
`productive` 和 `succeeded` 的区分很见功力:一次"搜了但没命中"的调用**不是失败**(不该触发熔断),但**也不算证据**(不能凭它就说"我查过了")。如果没有这个区分,要么把"没命中"误判成失败触发熔断,要么让模型拿"我搜了个空"当挡箭牌绕过门禁。两种都错。这种对"成功 / 有收获"两个正交维度的建模,是把 Agent 做扎实的细节。
`─────────────────────────────────────────────────`

`getMissingRequirements`([reactAgentRunner.ts:295-303](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L295-L303))还支持两种门禁语义:`requiredToolNames`(全部都要成功)和 `requiredAnyOfToolNames`(至少一个成功),可组合使用。

---

## 护栏四:倒计时收尾(治"停不下来")

模型可能磨蹭到步数上限还不给答案。LoopAgent 的循环上界很有讲究([reactAgentRunner.ts:118-119](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L118-L119)):

```typescript
for (let step = initialStep; step <= maxSteps + 1 + 2; step++) {
  const isFinalAnswerStep = step > maxSteps;
```

循环跑的步数比 `maxSteps` 多几步,这几步是专门留的"收尾窗口"。进入收尾窗口后,`toolChoice` 被强制设为 `"none"`([reactAgentRunner.ts:131-132](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L131-L132)):

```typescript
const missingRequirements = getMissingRequirements(requiredToolNames, requiredAnyOfToolNames, successfulTools);
const toolChoice = isFinalAnswerStep && missingRequirements.length === 0 ? "none" : "auto";
```

`toolChoice: "none"` 从**协议层禁掉所有工具**——模型这一轮除了吐最终答案别无选择。这就是第 02 篇埋的伏笔:因为动作走的是协议而非文本,我们能用协议开关**强制**模型行为,而不是在 prompt 里"求"它。

如果收尾窗口用完还不给答案,最后一道兜底([reactAgentRunner.ts:272](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L272)):

```typescript
throw new Error("Model did not produce a final answer");
```

`✶ Insight ─────────────────────────────────────`
注意收尾和证据门禁的**优先级**:`toolChoice` 只在 `missingRequirements.length === 0`(证据齐了)时才设 `"none"`。也就是说——如果模型还没真查过东西,即便到了收尾窗口,也不禁工具,而是继续逼它去查(护栏三)。"不许瞎编"的优先级高于"赶紧收尾"。两道护栏的这种协作顺序,是刻意设计的。
`─────────────────────────────────────────────────`

---

## 附加:并发批次里的写冲突防护

第 04 篇讲过并发执行。但并发有个风险:两个都要写文件的工具并行跑会冲突。LoopAgent 的分批算法保证**只有连续的、都并发安全的工具才会合进同一并行批次**([reactAgentRunner.ts:310-327](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/reactAgentRunner.ts#L310-L327)):

```typescript
for (const [index, request] of requests.entries()) {
  const concurrent = isConcurrencySafe(request, toolsByName);
  const previous = batches.at(-1);
  if (concurrent && previous?.concurrent) {
    previous.requests.push({ request, call: index + 1 });  // 并入上一并行批
    continue;
  }
  batches.push({ concurrent, requests: [{ request, call: index + 1 }] });  // 否则单独成批
}
```

只读的 `explore_code` 可以扎堆并行,一旦遇到会写文件的 `apply_edit`,它就单独成批串行执行。安全和性能兼顾。

---

## 五道护栏全景

| 翻车方式 | 护栏 | 记分板 | 源码 |
|---------|------|-------|------|
| 鬼打墙(重复调用) | 相同签名拦截 + 引导消息 | `succeededCalls` | `:212-220` |
| 撞南墙(反复失败) | 连续失败熔断 | `toolFailures` | `:252-258` |
| 睁眼说瞎话(无证据) | `productive` + 证据门禁 | `successfulTools` | `:147-156, 240` |
| 停不下来 | 倒计时强制收尾 | — | `:118-132, 272` |
| 并发写冲突 | 分批串行化 | — | `:309-326` |

这五道护栏,单看每一道都不复杂。但正是它们的叠加,把一个"跑得通的 ReAct demo"变成了一个"敢让它动你代码库的产品"。**Agent 的工程质量,往往不体现在主循环有多聪明,而体现在这些护栏有多周全。**

---

## 系列结语 & 项目推广

到这里,我们从"AI 怎么边想边做"的直觉出发,一路走到了函数调用式 ReAct 的协议细节和工程护栏。如果这五篇让你对 AI Agent 的内部机理有了更实在的理解,那它们的目的就达到了。

所有源码都来自我的开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)** —— 一个把 AI 编码 Agent 塞进 VS Code 的扩展。本系列拆的只是它的推理内核,项目里还有更多值得一看的东西:

- 🧠 **函数调用式 ReAct 内核**——就是本系列的主角,`src/extension/agent/`;
- 🔍 **本地代码智能索引**——SQLite FTS5 + 内存降级双路径,10K 符号查询 <10ms,让 Agent 秒级定位代码;
- 🔀 **工作流编排**——把多个 Agent 步骤编成可复用工作流,支持动态生成与失败恢复;
- 👁 **视觉分析**——能读你贴进来的截图 / 设计稿;
- 💾 **长期记忆**——跨会话记住你的偏好和项目上下文。

技术栈全自研 TypeScript,没有藏在框架背后的黑盒,**每一层都可读、可改、可学**。无论你是想学 Agent 原理、想找一个能改的脚手架,还是想直接用一个开源的编码助手,都欢迎来看看。

### 🌟 如果这个系列帮到了你

**去给 LoopAgent 点个 Star,是对开源作者最直接的鼓励:**

👉 **https://github.com/oi12344/loopagent-vscode** ⭐

也欢迎:
- 提 **Issue** 反馈问题或想法;
- 提 **PR** 一起把开源的 Coding Agent 打磨得更好;
- 把这个系列**转发**给同样对 AI Agent 好奇的朋友。

感谢读到这里。我们下个系列见。🚀

---

📖 上一篇:04 · 一步发多个工具:多 tool_call 的格式

> 开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)** ⭐ → https://github.com/oi12344/loopagent-vscode
