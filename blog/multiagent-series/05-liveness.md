# 05 · 它是卡住了,还是在干活?

假设你派出这么一个任务:

> 把 `formatDate` 的返回值改成 UTC,改完跑一遍全量测试确认没崩。提醒一下,我们那套测试跑完大概要四分钟。

子智能体接了活。60 秒过去,它一条消息都没产生。

**杀,还是不杀?**

杀错了,你亲手掐死一个正在做正确事情的节点——它只是在等 `npm test` 返回。不杀,那真正挂死的节点会一直占着并发槽位,后面排队的一个都进不来。

难点在于:这两种情况**在外部看起来完全一样**。都是"60 秒没动静"。你手上没有任何信息能区分它们——至少,不是靠看时间。

这篇讲 LoopAgent 怎么解,以及为什么最直觉的那个方案一定是错的。

## 墙钟超时必然误杀

最自然的实现是这样:

```ts
setTimeout(() => {
  controller.abort();
  settle(entry, { status: "failed", error: "timed out" });
}, 60_000);
```

简单、清晰、错的。

考虑一个 executor 子智能体,任务是"改完代码跑测试":

```
t=0s    开始
t=3s    exploreCode 找到目标            → 产生日志
t=8s    readFile 读实现                 → 产生日志
t=15s   applyEdit 改代码                → 产生日志
t=18s   runCommand("npm test")          → 产生日志
t=18s ~ t=258s  ...测试在跑...          → 一条日志都没有
t=258s  测试通过,继续
```

`npm test` 跑了四分钟,这期间子智能体**一条消息都不会产生**——它在等一个子进程。墙钟超时会在 t=60s 精准地杀掉一个**完全健康、正在做正确的事**的节点。而用户明明在任务里就提前告知过"测试跑完大概要四分钟"。

把超时调大到 300 秒?那真正卡死的节点就要浪费 300 秒才被发现。而且下次遇到一个跑 400 秒的测试套件,同样的问题又来了。

**墙钟时长和"是否健康"之间没有可靠的相关性。** 这是问题的本质。

`✶ 为什么这个问题在传统系统里不明显`
传统的 RPC 超时之所以能用墙钟,是因为请求的耗时分布相对稳定——你知道一个数据库查询该在 100ms 内返回。而 Agent 任务的耗时分布**跨了三个数量级**:一次 `readFile` 是 5ms,一次完整的测试套件是 5 分钟,两者都是正常的。对一个方差这么大的分布设单一阈值,不管设多少都是错的。

## 换个问法:它有没有在推进?

LoopAgent 的解法是**不再问"跑了多久",而问"这段时间里有没有变化"**。

墙钟从"死线"降级为"观察间隔":每 60 秒看一眼日志,看完做一个判断——有推进就再等一轮,没推进才动手。

判断结果有四种:

```ts
// workflow/subagentProgress.ts
/**
 * 子智能体的推进状态。墙钟到点不再直接判死,而是先看这一段时间里日志有没有变化:
 * - `progressing` 有新消息,模型在往前走,延长观察窗;
 * - `blocked`     没有新消息,但有工具调用尚未回来(长命令、等审批),同样延长;
 * - `stalled`     没有新消息也没有在跑的工具,模型自己挂住了,停止处理;
 * - `looping`     反复发同一个工具调用,消息在涨但没有进展,停止处理。
 *
 * `blocked` 必须和 `stalled` 分开:一个跑 `npm test` 的 executor 在命令返回前不产生任何
 * 消息,按 `stalled` 处理会把正常工作的节点杀掉——那正是把墙钟换成进度判定要避免的事。
 */
export type SubagentProgressState = "progressing" | "blocked" | "stalled" | "looping";
```

这四态里,`blocked` 和 `stalled` 的区分是整个设计的核心:

|  | 有新消息 | 有在跑的工具 | 判定 | 处理 |
|--|---------|------------|------|------|
| 模型在正常推进 | ✓ | — | `progressing` | 继续等 |
| 在跑 `npm test` | ✗ | **✓** | `blocked` | **继续等** |
| 模型自己挂了 | ✗ | ✗ | `stalled` | 停止 |
| 反复调同一个工具 | ✓ | — | `looping` | 停止 |

第二行和第三行的**外部表现完全一样**(都是没有新消息),但一个该等、一个该杀。区分它们的唯一信息是「有没有一个已开始未结束的工具调用」。

## 判定函数

```ts
// workflow/subagentProgress.ts
export function evaluateSubagentProgress(
  messages: readonly HostToWebviewMessage[],
  previousMessageCount: number,
  options: SubagentProgressOptions = {},
): SubagentProgressVerdict {
  const loopThreshold = options.loopThreshold ?? DEFAULT_LOOP_THRESHOLD;
  const pendingToolCalls = collectPendingToolCalls(messages);

  // 循环优先于"有新消息"判定:反复调同一个工具会一直产生新消息,只看条数会误判成推进。
  const repeated = findRepeatedToolCall(messages, loopThreshold);
  if (repeated) {
    return {
      state: "looping",
      reason: `repeated the tool call '${repeated.signature}' ${repeated.count} times without progressing`,
    };
  }

  if (messages.length > previousMessageCount) {
    const added = messages.length - previousMessageCount;
    return {
      state: "progressing",
      reason: `produced ${added} new log ${added === 1 ? "entry" : "entries"}`,
    };
  }

  if (pendingToolCalls.length > 0) {
    return {
      state: "blocked",
      reason: `waiting on ${pendingToolCalls.length} unfinished tool ${pendingToolCalls.length === 1 ? "call" : "calls"}: ${pendingToolCalls.join(", ")}`,
    };
  }

  return {
    state: "stalled",
    reason: messages.length === 0
      ? "produced no output at all"
      : "produced no new output and has no tool call in flight",
  };
}
```

**判定顺序很关键。** `looping` 检查放在最前面,注释解释了原因:一个反复调同一个工具的子智能体**会一直产生新消息**,如果先判 `progressing`,它永远都是"在推进"——但它其实在原地打转。

所以顺序是:先排除假性推进(looping),再看真推进(progressing),再看合理阻塞(blocked),剩下的才是真卡死(stalled)。

`✶ "有变化"不等于"有进展"`
这是活性检测里最容易踩的坑。日志在涨、CPU 在转、消息在发——这些都只证明**系统在动**,不证明**任务在推进**。一个死循环是世界上最"活跃"的程序。所以任何基于"有没有活动"的健康判定,都必须配一个循环检测,否则它会把最糟糕的失败模式判为最健康。

## pending 工具怎么算出来

`blocked` 判定依赖"有没有在跑的工具"。这个信息不需要额外记录,从消息流里就能配对出来:

```ts
/** 已开始未结束的工具调用名。按 `callId` 配对,不靠出现顺序猜。 */
function collectPendingToolCalls(messages: readonly HostToWebviewMessage[]): string[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.type === "toolCallStarted") pending.set(message.callId, message.toolName);
    else if (message.type === "toolCallFinished") pending.delete(message.callId);
  }
  return [...pending.values()];
}
```

`toolCallStarted` 入表,`toolCallFinished` 出表,剩下的就是在跑的。

注释里"不靠出现顺序猜"点出了关键:**按 `callId` 配对**。因为并发批次里多个工具同时开始、乱序结束,`started` 和 `finished` 在消息流里是交错的。用计数(started 数减 finished 数)在数字上也对,但拿不到具体是哪个工具还在跑——而那个名字要出现在 `reason` 里给用户看。

## 循环检测的阈值为什么是 3

```ts
/**
 * 同一个 `toolName|input` 出现多少次算循环。取 3 而不是 2:读同一个文件两次可能是
 * 先看结构再看细节,第三次基本没有新信息可拿。
 */
const DEFAULT_LOOP_THRESHOLD = 3;

function findRepeatedToolCall(
  messages: readonly HostToWebviewMessage[],
  threshold: number,
): { signature: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.type !== "toolCallStarted") continue;
    const signature = `${message.toolName}(${message.input})`;
    const next = (counts.get(signature) ?? 0) + 1;
    if (next >= threshold) return { signature: truncate(signature), count: next };
    counts.set(signature, next);
  }
  return undefined;
}
```

签名是 `toolName(input)` ——工具名加完整参数。同参数才算重复,`readFile("a.ts")` 和 `readFile("b.ts")` 是两回事。

阈值取 3 而非 2 的理由写在注释里:读同一个文件两次是**正常行为**(先看整体结构,再回头看某个细节)。第三次就基本没有新信息了。这种阈值选择没有理论最优解,但把"为什么不是 2"写下来,让后来人知道这是权衡过的,不是随手写的。

## 装进定时器

判定函数是纯函数,不碰计时器。真正的循环在 `start()` 里:

```ts
// workflowOrchestrator.ts
// 进度判定取代硬性死线。每隔 timeoutMs 看一次日志:有推进就再等一轮,卡住或打转
// 就立刻停止。名义时长用轮次乘间隔而不是实测墙钟,文案才是确定的。
let checkCount = 0;
let lastMessageCount = 0;
let currentTimeoutMs = entry.timeoutMs;
const scheduleProgressCheck = (): void => {
  entry.timeout = setTimeout(() => {
    if (controller.signal.aborted || entry.context.snapshot().status !== "running") return;
    checkCount++;
    const nominalElapsedMs = checkCount * entry.timeoutMs;
    const verdict = evaluateSubagentProgress(entry.messages, lastMessageCount);
    lastMessageCount = entry.messages.length;

    if (verdict.state === "progressing" || verdict.state === "blocked") {
      // 使用自适应超时评估是否需要调整超时时长
      const adjustment = evaluateTimeoutAdjustment(entry.messages);
      const adjustedTimeout = Math.floor(entry.timeoutMs * adjustment.suggestedMultiplier);
      currentTimeoutMs = Math.min(adjustedTimeout, entry.maxTimeoutMs - nominalElapsedMs);

      if (nominalElapsedMs + currentTimeoutMs <= entry.maxTimeoutMs) {
        emit({ /* progress check 事件,含 verdict 和调整原因 */ });
        scheduleProgressCheck();     // ← 递归续期
        return;
      }
      controller.abort();
      settle(entry, {
        status: "failed",
        error: `Subagent timed out after ${nominalElapsedMs}ms: reached the ${entry.maxTimeoutMs}ms limit while still ${verdict.state}`,
      });
      return;
    }

    controller.abort();
    // stalled 保留原文案:什么都没发生就是超时,分类为 transient 后可重试。
    // looping 用不含 "timed out" 的文案,好让分类器给出 planning——重试一个
    // 打转的节点只会再打转一次,得改任务而不是重跑。
    settle(entry, {
      status: "failed",
      error: verdict.state === "looping"
        ? `Subagent stopped making progress after ${nominalElapsedMs}ms: ${verdict.reason}`
        : `Subagent timed out after ${nominalElapsedMs}ms`,
    });
  }, entry.timeoutMs);
};
scheduleProgressCheck();
```

**`scheduleProgressCheck` 递归调自己**。每次判定为健康,就再排一个定时器。定时器链只在判定为不健康、或撞到绝对上限时才断开。

**错误文案是精心区分的。** 注释解释了为什么:下游有个错误分类器,靠文案里有没有 "timed out" 来决定重试策略。

- `stalled` → 文案含 "timed out" → 分类为 transient → **可以重试**(可能只是运气不好)
- `looping` → 文案不含 "timed out" → 分类为 planning → **不该重试**(重跑一个打转的节点只会再打转,得改任务本身)

这是一个很实际的细节:**错误信息不只给人看,也给程序看。** 文案的措辞成了接口的一部分。

## 名义时长 vs 实测墙钟

```ts
const nominalElapsedMs = checkCount * entry.timeoutMs;
```

累计时长是**轮次 × 间隔**算出来的,不是 `Date.now()` 相减。

注释说"文案才是确定的"——因为 `setTimeout` 从不精确,实测墙钟会是 60000、120017、180043 这种数,给用户看很难看。用名义时长,文案永远是整齐的 60000ms、120000ms。

这里有个诚实的代价值得指出:当自适应超时把某一轮的间隔从 60s 拉长到 120s 时,`nominalElapsedMs` 仍然按 `checkCount * 60s` 计。所以**名义时长会低于真实经过的时间**。这个偏差不影响 `maxTimeoutMs` 作为安全上限的作用(它只会让实际运行超过名义上限,而不会更早杀),但读文案时要知道那个数字是"检查轮次的名义累计",不是秒表。

## 自适应观察窗

每次判定健康时,`evaluateTimeoutAdjustment` 会给出下一轮该等多久:

```ts
// workflow/adaptiveTimeout.ts
export function evaluateTimeoutAdjustment(
  messages: readonly HostToWebviewMessage[],
  recentWindowSize = 5,
): TimeoutAdjustment {
  if (messages.length < 3) {
    return { shouldExtend: false, reason: "Too few messages to evaluate pattern", suggestedMultiplier: 1.0 };
  }

  const recentMessages = messages.slice(-recentWindowSize);
  const recentToolCalls = extractToolCalls(recentMessages);

  // 策略1:工具多样性检测
  const uniqueTools = new Set(recentToolCalls.map((call) => call.toolName));
  const diversityScore = uniqueTools.size / Math.max(recentToolCalls.length, 1);

  if (diversityScore >= 0.6 && recentToolCalls.length >= 3) {
    // 最近的调用有60%以上是不同工具 → 正在多角度探索
    return { shouldExtend: true, reason: `High tool diversity (...)`, suggestedMultiplier: 1.5 };
  }

  // 策略2:单一重复工具检测
  if (diversityScore < 0.3 && recentToolCalls.length >= 3) {
    // 最近的调用中工具重复度很高 → 可能陷入循环或死磕一个问题
    const mostCommonTool = findMostCommonTool(recentToolCalls);
    return { shouldExtend: false, reason: `Low tool diversity, repeating ${mostCommonTool} (...)`, suggestedMultiplier: 0.8 };
  }

  // 策略3:长时间运行的工具检测
  const hasLongRunningTool = detectLongRunningTools(recentMessages);
  if (hasLongRunningTool) {
    return { shouldExtend: true, reason: "Detected long-running tool (test/build/compile), extending timeout", suggestedMultiplier: 2.0 };
  }

  // 策略4:稳定推进模式
  const hasConsistentProgress = checkConsistentProgress(messages);
  if (hasConsistentProgress) {
    return { shouldExtend: true, reason: "Consistent progress pattern detected", suggestedMultiplier: 1.2 };
  }

  return { shouldExtend: false, reason: "No clear pattern, maintaining current timeout", suggestedMultiplier: 1.0 };
}
```

四条策略,四个乘数:

| 观察到的模式 | 乘数 | 判断依据 |
|------------|------|---------|
| 工具多样性 ≥ 0.6 | **1.5×** | 在多角度探索,值得多给时间 |
| 工具多样性 < 0.3 | **0.8×** | 在死磕一个工具,缩短观察窗以更快发现问题 |
| 检测到 test/build 在跑 | **2.0×** | 明确知道这类命令慢 |
| 最近 10 条有 ≥3 种活动 | **1.2×** | 稳定推进,略微延长 |

这张表描述的是 `evaluateTimeoutAdjustment` 的**输出**,不是它的**效果**——效果那一半留到本文最后一节。

第三条最有价值,它是**语义化的**:

```ts
function detectLongRunningTools(messages: readonly HostToWebviewMessage[]): boolean {
  const longRunningPatterns = [
    /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
    /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
    /\bcargo\s+(test|build)\b/,
    /\bgo\s+(test|build)\b/,
    /\bmvn\s+(test|compile)\b/,
    /\bgradle\s+(test|build)\b/,
  ];

  for (const message of messages) {
    if (message.type === "toolCallStarted" && message.toolName === "runCommand") {
      const command = message.input;
      if (longRunningPatterns.some((pattern) => pattern.test(command))) {
        // 检查这个命令是否还在运行（未 finished）
        const callId = message.callId;
        const finished = messages.some(
          (m) => m.type === "toolCallFinished" && m.callId === callId,
        );
        if (!finished) return true;
      }
    }
  }

  return false;
}
```

它认识 `npm test`、`cargo build`、`mvn compile` 这些具体命令,并且**只在这个命令还没结束时**才返回 true(`if (!finished)`)。所以是"此刻正在跑一个已知的慢命令",不是"历史上跑过"。

回到本文开头那个例子:一个 `npm test` 跑四分钟的 executor。t=60s 的检查点上,`evaluateSubagentProgress` 看到一个 pending 的 `runCommand` 返回 `blocked`,`evaluateTimeoutAdjustment` 认出 `npm test` 正在跑,给 2.0×。节点活下来了。t=120s、t=180s、t=240s 三个检查点上,情况一模一样,三次都活下来。测试在 t=258s 结束,下一个检查点看到新消息,判为 `progressing`。节点从头到尾安然无恙——而墙钟超时会在第一个检查点就杀掉它。

**但有个细节要说清楚:乘数并没有改变检查间隔。** 第 377 行算出的 `currentTimeoutMs` 只进了第 379 行的闸门判断和日志文案,而 `setTimeout` 的延时写的是 `entry.timeoutMs`:

```ts
// workflowOrchestrator.ts:365-410 — 注意首尾两行
const scheduleProgressCheck = (): void => {
  entry.timeout = setTimeout(() => {
    // ...
    currentTimeoutMs = Math.min(adjustedTimeout, entry.maxTimeoutMs - nominalElapsedMs);
    if (nominalElapsedMs + currentTimeoutMs <= entry.maxTimeoutMs) {
      emit({ /* ...Timeout adjustment: ${adjustment.reason} */ });
      scheduleProgressCheck();
      return;
    }
    // ...
  }, entry.timeoutMs);   // ← 延时始终是 60 秒,与 currentTimeoutMs 无关
};
```

所以上面那条时间线里的四个检查点,间隔都是 60 秒——2.0× 没有把它拉到 120 秒。**这不影响结论**(节点照样活下来,因为每次判定都是 `blocked`),但它意味着乘数在当前实现里的作用范围比它看起来的小得多。下一节会看到,这个"小得多"最后小到了零。

`✶ 语义 > 统计`
四条策略里,基于命令名的模式匹配(策略3)比基于统计的多样性打分(策略1、2)可靠得多。原因很简单:多样性分数只能推测"看起来像在探索",而 `npm test` 就是 `npm test` ——你确定地知道它慢。做启发式判断时,**能用领域知识就别用统计特征**,前者的误判率低一个数量级。

## 两道墙,其中一道是画的

最后看限额:

```ts
const DEFAULT_LIMITS: WorkflowLimits = {
  maxSubagentsPerRun: 50,
  maxNestingDepth: 3,
  maxConcurrentSubagents: 10,
  subagentTimeoutMs: 60_000,
  // 60s 装不下 executor 的完整流程(定位 → 读文件 → 改代码 → 跑验证,每步一次模型往返,
  // runCommand 自己还有 30s 默认超时)。给到 5 轮观察窗,只在真的有推进时才用得上。
  maxSubagentTimeoutMs: 300_000,
};
```

类型定义里对这两个值的角色写得很清楚:

```ts
// workflow/types.ts
export type WorkflowLimits = {
  // ...
  /**
   * 进度检查间隔。每过这么久看一次日志:有推进就再等一轮,卡住或打转就停止处理。
   * 不再是硬性死线——硬性死线是 `maxSubagentTimeoutMs`。
   */
  subagentTimeoutMs: number;
  /**
   * 绝对上限。推进判定可以一轮轮延长,但延长必须有天花板:一个不停产生日志却永远
   * 不收敛的子智能体,靠"有新消息就是在推进"是判不出来的,只能靠这堵墙拦住。
   */
  maxSubagentTimeoutMs: number;
};
```

**`maxSubagentTimeoutMs` 存在的理由值得单独强调。** 进度判定有一个根本缺陷:一个每 30 秒产生一条无意义日志、但永远不收敛的子智能体,每次检查都会被判为 `progressing`,于是无限续期。

循环检测抓不住它——只要它每次调用的参数略有不同,签名就不重复。进度判定也抓不住它——它确实在产生新消息。

**能拦住它的只有一堵绝对的墙。** 这是所有基于"健康度"的自适应机制都必须配的东西:自适应负责在正常情况下做对的事,绝对上限负责在自适应被欺骗时兜底。

### 这堵墙目前是画上去的

上面那段是设计意图。读代码会发现,这堵墙在当前实现里**永远不会开枪**:

```ts
// workflowOrchestrator.ts:377-379
currentTimeoutMs = Math.min(adjustedTimeout, entry.maxTimeoutMs - nominalElapsedMs);

if (nominalElapsedMs + currentTimeoutMs <= entry.maxTimeoutMs) {
  scheduleProgressCheck();   // 续期
  return;
}
controller.abort();          // ← 这里到不了
```

`Math.min` 把闸门做成了恒真式。分两种情况:

- `adjustedTimeout` 较小时,`currentTimeoutMs = adjustedTimeout`,闸门就是"`adjustedTimeout` 较小"这个前提本身,必然成立;
- `maxTimeoutMs - nominalElapsedMs` 较小时,`currentTimeoutMs` 被夹成它,于是 `nominalElapsedMs + currentTimeoutMs` **恰好等于** `maxTimeoutMs`,`<=` 依然成立。

两条路都通过。名义时长冲到 600 秒时,`currentTimeoutMs` 已经是 `-300000` 了,和仍然是 300000,闸门照样放行。所以第 392-396 行那段 `settle({ status: "failed" })` 是**不可达代码**——一个持续产出新消息的子智能体,可以无限期地活着。

真正在拦住失控节点的是另一条路径。看清楚闸门的位置:它在 `if (verdict.state === "progressing" || verdict.state === "blocked")` 这个块**里面**。`stalled` 和 `looping` 压根不进这个块,它们直接走到第 400 行往后的 `controller.abort()`,不经过闸门——所以那两条判定工作正常。

这就是分工:**`looping` 和 `stalled` 在干活,`maxSubagentTimeoutMs` 在装样子。** 前面说的"反复调同一个工具的子智能体"能被停掉,靠的是 `looping` 判定,不是这堵墙。而这堵墙本该拦住的那类——每次参数都略有不同、签名不重复、消息一直在涨的——恰好是 `looping` 抓不住的那类。**两个机制的覆盖范围本应互补,现在其中一个是空的。**

这个缺口在测试里留了痕迹:

```ts
// test/workflowOrchestrator.test.ts:358
it.skip("stops a chatty subagent once the absolute ceiling is reached", async () => {
```

`it.skip` ——一条针对"一直说话但永不收敛"的测试,被跳过了。它尾巴上还挂着 `}, 15000); // Increase timeout to 15s`,是有人调过、没调通、然后跳过的样子。**这条测试写对了,是实现没跟上。**

修法很直接,把夹取和判定分开:

```ts
if (nominalElapsedMs >= entry.maxTimeoutMs) {
  controller.abort();
  settle(entry, { status: "failed", error: `Subagent timed out after ${nominalElapsedMs}ms: ...` });
  return;
}
scheduleProgressCheck();
```

`✶ 兜底逻辑为什么最容易烂掉`
两件事在这里是同一件事:一段不可达的代码,和一条被 skip 的测试。兜底路径的特点是**只在异常情况下执行**,而异常情况在开发时很难自然发生——于是它不像主路径那样被日常使用反复验证。这类代码只有两种状态:有测试覆盖,或者已经坏了但没人知道。看到 `it.skip` 挂在一个 backstop 上,基本可以直接假设那个 backstop 是坏的。

至此,活性问题的主体解决了:进度判定替掉了墙钟,`stalled` 和 `looping` 各自有真实作用,只剩绝对上限还欠一个修复。回到开头那个问题——"杀,还是不杀"——答案是**都不问**,改问"这 60 秒里有没有变化"。

但还剩最后一个:如果我真的想让两个 executor 同时改代码呢?下一篇讲 git worktree。

---

## 关于 LoopAgent

本文代码来自 [LoopAgent](https://github.com/oi12344/loopagent-vscode)。涉及的文件:

- [src/extension/agent/workflow/subagentProgress.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/subagentProgress.ts) — 四态推进判定
- [src/extension/agent/workflow/adaptiveTimeout.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/adaptiveTimeout.ts) — 自适应观察窗
- [src/extension/agent/workflowOrchestrator.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflowOrchestrator.ts) — 定时器链与结算
- [src/extension/agent/workflow/types.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/types.ts) — 两道墙的定义

对应测试:[test/workflow/subagentProgress.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/workflow/subagentProgress.test.ts)、[test/workflow/adaptiveTimeout.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/workflow/adaptiveTimeout.test.ts)

欢迎点个 star ⭐

**项目地址**:https://github.com/oi12344/loopagent-vscode

---

📖 上一篇:04 · 四个角色,四套权限 ｜ 下一篇:06 · 让两个 executor 同时改代码
