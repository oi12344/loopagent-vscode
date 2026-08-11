# 06 · 让两个 executor 同时改代码

假设你派了这么一个活:

> 用户表和订单表的时间字段都要迁到 UTC。`userService` 和 `orderService` 分头改,**别互相等**,两个都改完各自跑一遍测试。

"别互相等"是一句很自然的要求——两个服务是独立的,凭什么要排队。但第 03 篇讲调度器时,有一行代码把这个要求直接否掉了:

```ts
&& !(snapshot.role === "executor" && hasRunningExecutor)
```

**一个 executor 在跑,第二个就得等。** 用户的"别互相等"在调度层被无声地改成了"排队"。

理由不是保守,是真有东西会坏。两个任务都得往同一个地方加一个 `toUtc` 辅助函数:

```
subagent-1  改 userService.ts   + utils/dateFormat.ts
subagent-2  改 orderService.ts  + utils/dateFormat.ts
                                  ↑ 同一个文件
```

在共享工作区里,时间线会长这样:

```
t=0s    subagent-1  readFile dateFormat.ts   → 拿到 v1
t=2s    subagent-2  readFile dateFormat.ts   → 也拿到 v1
t=5s    subagent-1  applyEdit                → 基于 v1 写入,成功
t=7s    subagent-2  applyEdit                → 基于 v1 写入,结果不确定
```

这里值得停一下,因为 LoopAgent 的 `applyEdit` **不是**按行号或偏移量定位的,它按锚点文本定位:

```ts
// editPreviewService.ts:317-322
const { match, matchCount } = findTextMatch(current, change.oldText);
if (match === null) {
  throw new Error(matchCount === 0
    ? "Invalid replace operation: oldText not found in file"
    : `Invalid replace operation: oldText matches ${matchCount} times (expected exactly 1)`);
}
```

`findTextMatch` 做的是精确子串匹配(只额外容忍 CRLF/LF 差异),并且要求**全文恰好命中一次**——零次和多次都抛错。

这个设计挡掉了最经典的那种丢失更新:t=7s 不可能悄悄覆盖掉 subagent-1 的改动,因为一旦 subagent-1 动过 subagent-2 锚定的那段文本,`matchCount` 就变成 0,写入直接失败。**数据是安全的。** 但请注意,安全的方式是"让工作失败",于是 t=7s 剩下三种结局:

| 情况 | 结果 | 响不响 |
|------|------|--------|
| subagent-1 改动了 subagent-2 锚定的那段 | `matchCount === 0` → 抛错 | 响 |
| subagent-1 的写入让锚点文本变成两处 | `matchCount === 2` → 抛错 | 响 |
| 两人锚点不重叠,各自加了一个 `toUtc` | **两边都成功** | **不响** |

前两行是 subagent-2 **什么都没做错却拿到一个错误**——错误来自邻居,而报错信息里没有任何它能据此行动的线索(它只知道"锚点没找到",不知道是谁动了)。它大概会重新 `readFile` 再试一次,这是对的恢复动作,代价是一次多余的模型往返。

第三行才是真正难受的:`dateFormat.ts` 里现在有**两个 `toUtc` 函数**。两个子智能体都成功了,都会汇报"改完了",而 TypeScript 会在重复声明上直接编译失败——谁都没错,构建挂了。

这就是问题的形状:锚点校验把"数据丢失"换成了"工作失败或结果错误",而三种结局里你拿到哪一种,取决于两个子进程谁先返回。串行化能彻底消掉这个不确定性,代价是用户的"别互相等"落空。

这一篇讲另一条路:**给每个 executor 一份独立的文件系统,让它们真的能并行写**。

## git worktree 是什么

`git worktree` 让同一个仓库**同时签出多个工作目录**,每个目录在不同分支上,共享同一份 `.git` 对象库。

```
E:/work/myproject/              ← 主工作区,分支 main
E:/work/myproject/.claude/worktrees/
  ├─ subagent-1-1699.../        ← worktree,分支 worktree/-userservice-utc-1699...
  └─ subagent-2-1700.../        ← worktree,分支 worktree/-orderservice-utc-1700...
```

三个目录是**三份独立的文件**。subagent-1 改它目录里的 `utils/dateFormat.ts`,subagent-2 改它目录里的同一个文件,互不可见、互不冲突。前面那条丢失更新的时间线在这里根本组不起来——t=2s 的 `readFile` 读的已经不是同一个 inode 了。

比 `git clone` 好的地方是:对象库共享,所以创建一个 worktree 几乎不占额外空间,也不需要重新下载历史。

## 创建

```ts
// workflow/worktreeManager.ts
export function createWorktreeManager(repoPath: string): WorktreeManager {
  const worktreeBaseDir = join(repoPath, ".claude", "worktrees");

  async function isGitRepo(): Promise<boolean> {
    try {
      await execAsync("git rev-parse --git-dir", { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  async function getCurrentBranch(): Promise<string> {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
    return stdout.trim();
  }

  async function createWorktree(subagentId: string, task: string): Promise<WorktreeInfo> {
    // 生成唯一的分支名
    const timestamp = Date.now();
    const sanitizedTask = task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30);
    const branch = `worktree/${sanitizedTask}-${timestamp}`;

    // Worktree 路径
    const worktreePath = join(worktreeBaseDir, `${subagentId}-${timestamp}`);

    // 获取当前分支作为基础
    const baseBranch = await getCurrentBranch();

    try {
      // 创建 worktree 和新分支
      await execAsync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
        cwd: repoPath,
      });

      return { path: worktreePath, branch, subagentId };
    } catch (error) {
      throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // ...
}
```

分支名从**任务描述**生成:小写、非字母数字换成连字符、截断 30 字符,再拼时间戳。中文任务描述在这里会被 `/[^a-z0-9]+/g` 整段吃掉,只剩下里面的 ASCII 标识符。开头那个任务"把 userService 的时间字段迁到 UTC"过一遍是这样:

```
"把 userService 的时间字段迁到 UTC"
  → toLowerCase()                    "把 userservice 的时间字段迁到 utc"
  → replace(/[^a-z0-9]+/g, "-")      "-userservice-utc"
  → slice(0, 30)                     "-userservice-utc"
  → 拼时间戳                          worktree/-userservice-utc-1699887766123
```

刚好因为任务里带了 `userService` 和 `UTC` 两个标识符,分支名还认得出来。要是任务写成纯中文的"迁移时间字段",整个 `sanitizedTask` 就只剩一个 `-`,分支名退化成 `worktree/--1699887766123`。可读性完全依赖任务描述里恰好有没有 ASCII 词,唯一性则总是由时间戳兜住。

## 只给 executor

```ts
// workflowOrchestrator.ts — start() 里
if (snapshot.role === "executor" && worktreeManager && isGitRepo && options.enableWorktreeIsolation !== false) {
  try {
    const worktreeInfo = await worktreeManager.createWorktree(snapshot.id, snapshot.task);
    entry.worktree = worktreeInfo;
    emit({ /* "Created isolated worktree at ..." */ });
  } catch (error) {
    // Worktree 创建失败不应阻止子代理运行,记录警告即可
    emit({ /* "Warning: Failed to create worktree, proceeding without isolation: ..." */ });
  }
}
```

四个前置条件全部满足才创建:是 executor、有 manager、在 git 仓库里、没被显式关掉。

**创建失败不阻塞运行。** `catch` 里只发一条警告,然后子智能体照常跑——只是没有隔离。这是个合理的降级:worktree 是优化,不是必需。在非 git 目录、磁盘满、git 版本太老的情况下,功能退化到"串行执行"而不是"直接失败"。

## 难点:让工具调用去对的目录

worktree 建好了,但子智能体的工具**不知道它存在**。子智能体说"读 `E:/work/myproject/src/auth.ts`",工具就去读主工作区那个文件——完全绕过了隔离。

所以每个工具调用的路径参数都要被重写:

```ts
// workflowOrchestrator.ts — start() 里传给 createRunner 的 invokeTool
invokeTool: ((request, signal) => {
  // 如果有 worktree,需要将工具调用重定向到 worktree 路径
  if (entry.worktree) {
    // 对于文件系统相关的工具,需要修改路径参数
    const modifiedRequest = modifyRequestForWorktree(request, entry.worktree.path, options.workspacePath!);
    return invokeTool(snapshot.tools, modifiedRequest, signal);
  }
  return invokeTool(snapshot.tools, request, signal);
}) satisfies ToolInvoker,
```

重写函数:

```ts
const TOOLS_NEEDING_WORKTREE_PATH_MODIFICATION = new Set([
  "readFile",
  "applyEdit",
  "exploreCode",
  "browseSymbols",
  "runCommand",
]);

export function modifyRequestForWorktree(
  request: ReactAgentToolRequest,
  worktreePath: string,
  originalWorkspacePath: string,
): ReactAgentToolRequest {
  if (!TOOLS_NEEDING_WORKTREE_PATH_MODIFICATION.has(request.name)) {
    return request;
  }
  if (!originalWorkspacePath) {
    return request;
  }

  // 递归替换参数中的路径
  const replacePaths = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.split(originalWorkspacePath).join(worktreePath);
    }
    if (Array.isArray(value)) {
      return value.map(replacePaths);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, replacePaths(entry)]),
      );
    }
    return value;
  };

  const modifiedInput = replacePaths(request.input);
  // ...
}
```

递归遍历整个 `input` 对象,把所有字符串里的主工作区路径换成 worktree 路径。递归是必要的——路径可能藏在嵌套对象或数组里,比如 `{ edits: [{ path: "...", oldStr: "..." }] }`。

## 一个很容易漏的 bug

这段代码后面还有一半,注释比代码长:

```ts
  // `input` 是工具实际执行使用的参数（见 toolRegistry.invokeRegisteredTool），而
  // `rawArguments` 被 computeToolCallSignature 用于重复调用去重。两者必须保持一致，
  // 否则去重签名看到原路径、实际执行走 worktree 路径。这里从替换后的 input 重新序列化，
  // 而不是对原 JSON 文本做替换 —— Windows 路径在 JSON 里是转义的（E:\\zz\\...），
  // 按未转义路径做字符串替换匹配不到。
  let modifiedRawArguments = request.rawArguments;
  if (request.parseError === undefined) {
    try {
      modifiedRawArguments = JSON.stringify(modifiedInput);
    } catch {
      // 含循环引用等无法序列化的输入：保留原文本，input 的替换仍然生效。
    }
  }

  return { ...request, input: modifiedInput, rawArguments: modifiedRawArguments };
}
```

这里有**两个**独立的坑,都很隐蔽。

**坑一:`input` 和 `rawArguments` 必须同步改。**

回忆上个系列讲的重复调用拦截——它用 `computeToolCallSignature(request)` 算签名,而签名基于 `rawArguments`(原始 JSON 文本)。如果只改 `input` 不改 `rawArguments`,会出现:

```
第一次调用: input 走 worktree 路径,签名基于原路径 → 缓存 key = "readFile(E:/work/proj/a.ts)"
第二次调用: 同样的签名 → 命中缓存,被拦截
```

看起来正常。但如果**主工作区**和 **worktree** 里的同名文件内容不同(它们当然不同,executor 正在改),那第二次的缓存命中就返回了错的内容。签名必须反映实际执行的参数。

**坑二:不能对 JSON 文本做字符串替换。**

最直觉的实现是 `request.rawArguments.split(originalPath).join(worktreePath)`。在 Linux 上能用,在 Windows 上**静默失效**:

```
真实路径:        E:\work\myproject
JSON 里的样子:   "E:\\work\\myproject"     ← 反斜杠被转义成双反斜杠
```

拿未转义的 `E:\work\myproject` 去匹配 `E:\\work\\myproject`,匹配不到。替换悄无声息地什么都没做,签名继续用原路径——坑一又回来了。

正确做法是从**已经替换好的 `input` 对象重新序列化**:`JSON.stringify(modifiedInput)`。这样转义由 `JSON.stringify` 负责,不需要手工处理。

`✶ 这个 bug 为什么值得单独讲`
它同时满足"平台相关"、"静默失败"、"影响的是缓存正确性而非崩溃"三个特征——这类 bug 在测试里极难暴露(Linux CI 上永远是绿的),在生产里表现为"偶尔读到过期内容"。避免它的通用原则是:**需要修改结构化数据的序列化形式时,永远改结构再重新序列化,不要在序列化后的文本上做手术。**

这个行为有专门的测试守着:[test/agent/worktreeRequestRewrite.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/agent/worktreeRequestRewrite.test.ts)。

## 结算:成功就合并,失败就丢弃

子智能体跑完,worktree 要清理。合不合并取决于结果:

```ts
// workflowOrchestrator.ts — settle() 里
if (entry.worktree && worktreeManager) {
  const keepChanges = result.status === "completed" && verification.verificationStatus === "passed";
  void worktreeManager.cleanupWorktree(entry.worktree, keepChanges).catch((error) => {
    // 记录清理失败,但不影响子代理的结果
    emit({ /* "Warning: Failed to cleanup worktree: ..." */ });
  });
}
```

`keepChanges` 要求**两个条件同时成立**:任务完成 **且** 验证通过。只是"没报错"不够——第 04 篇讲过 executor 的提示词要求它跑测试,这里就是检查它到底跑了没、过了没。

清理逻辑:

```ts
// workflow/worktreeManager.ts
async function cleanupWorktree(info: WorktreeInfo, keepChanges: boolean): Promise<void> {
  try {
    // 检查 worktree 是否仍然存在
    if (!existsSync(info.path)) {
      try {
        await execAsync(`git worktree remove "${info.path}" --force`, { cwd: repoPath });
      } catch {
        // 忽略错误，可能已经被删除
      }
      return;
    }

    if (keepChanges) {
      // 检查是否有未提交的更改
      const { stdout: statusOutput } = await execAsync("git status --porcelain", { cwd: info.path });

      if (statusOutput.trim()) {
        await execAsync('git add -A', { cwd: info.path });
        await execAsync(`git commit -m "Auto-commit from subagent ${info.subagentId}"`, { cwd: info.path });
      }

      const baseBranch = await getCurrentBranch();

      // 合并更改到当前分支
      await execAsync(`git merge --no-ff "${info.branch}" -m "Merge worktree changes from ${info.subagentId}"`, {
        cwd: repoPath,
      });

      await execAsync(`git worktree remove "${info.path}"`, { cwd: repoPath });
      await execAsync(`git branch -d "${info.branch}"`, { cwd: repoPath });
    } else {
      // 不保留更改，强制删除
      await execAsync(`git worktree remove "${info.path}" --force`, { cwd: repoPath });
      await execAsync(`git branch -D "${info.branch}"`, { cwd: repoPath }).catch(() => {
        // 忽略分支删除失败（可能不存在）
      });
    }
  } catch (error) {
    throw new Error(`Failed to cleanup worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

成功路径是 `add -A` → `commit` → `merge --no-ff` → 删 worktree → 删分支。用 `--no-ff` 是为了在历史里留下一个明确的合并节点,能看出"这段改动来自哪个子智能体"。

失败路径直接 `remove --force` + `branch -D` ——**改动全部丢弃**,主工作区一点痕迹都不留。这是隔离带来的额外好处:一个失败的 executor 不会留下半成品需要人工清理。

有一点要诚实指出:**两个 executor 并行时,合并可能冲突**。回到开头那个 UTC 迁移——两个子智能体都往 `utils/dateFormat.ts` 里加了 `toUtc`,大概率还加在同一个位置。subagent-1 先合进去没问题;subagent-2 的 `git merge` 撞上同一段,失败,抛出 `Failed to cleanup worktree: ...`。这个错误被 `settle()` 里的 `.catch()` 接住,只发一条警告——子智能体的结果仍然是 `completed`,但改动没进主分支。

跟开头那三种结局比,这里换到手的东西是具体的。

**开头的前两种结局直接消失了。** subagent-2 再也不会因为邻居动了文件而拿到"锚点没找到"——它的 worktree 里那个文件从头到尾只有它自己在写,`matchCount` 恒为 1。那两次多余的模型往返省掉了。

**第三种结局从"主工作区坏掉"变成"主工作区不动"。** 共享工作区里两个 `toUtc` 都写进去了,主分支当场编译不过,而且两个子智能体都汇报了成功——没人觉得自己该负责。换成 worktree:subagent-1 先合进去,主分支是干净可编译的;subagent-2 的 merge 撞上冲突失败,它的改动留在自己那条分支上。**主分支从未进入过坏状态**,冲突被隔离在一个可以慢慢看的地方。

代价是 subagent-2 那份工作现在需要人来收尾。但"一份工作待处理"和"主分支编译不过且没人知道为什么"不是一个量级的问题。

所以 worktree 隔离解决的是**执行期的写冲突**,不解决**合并期的语义冲突**。后者本质上需要人来判断——`toUtc` 该保留哪一份实现,git 没法替你决定。这也是为什么第 03 篇那条 executor 串行约束依然保留着:它是更保守但更可预测的路径,用"别互相等"落空换掉一整类合并问题。

## 验证检测:它到底跑了测试没

`keepChanges` 依赖的 `verificationStatus` 是这么算出来的:

```ts
// workflow/verificationDetector.ts
const VERIFICATION_PATTERNS = [
  // 测试命令
  /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
  /\b(pytest|jest|vitest|mocha|ava|tape)\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmvn\s+test\b/,
  /\bgradle\s+test\b/,

  // 类型检查
  /\btsc\b.*--noEmit/,
  /\b(npm|yarn|pnpm)\s+(run\s+)?typecheck\b/,
  /\bmypy\b/,

  // 构建命令
  /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
  // ... cargo/go/mvn/gradle build
  // Lint（部分验证）
  // ... eslint/ruff/clippy
];
```

然后从消息流里配对命令和结果:

```ts
export function detectVerificationFromMessages(messages: readonly HostToWebviewMessage[]) {
  const verificationCommands: string[] = [];
  const commandResults = new Map<string, { command: string; succeeded: boolean }>();
  let hasFailure = false;
  let failureReason: string | undefined;

  for (const message of messages) {
    // 记录验证命令的开始
    if (message.type === "toolCallStarted" && message.toolName === "runCommand") {
      const command = message.input;
      if (command && VERIFICATION_PATTERNS.some(pattern => pattern.test(command))) {
        verificationCommands.push(command);
        commandResults.set(message.callId, { command, succeeded: true });
      }
    }

    // 检查验证命令的结果
    if (message.type === "toolCallFinished") {
      const commandInfo = commandResults.get(message.callId);
      if (commandInfo) {
        commandResults.set(message.callId, { ...commandInfo, succeeded: message.succeeded });
        if (!message.succeeded) {
          hasFailure = true;
          failureReason = `Verification command failed: ${commandInfo.command}`;
        }
      }
    }
  }

  return {
    hasVerification: verificationCommands.length > 0,
    verificationCommands,
    verificationPassed: verificationCommands.length > 0 && !hasFailure,
    failureReason,
  };
}
```

四种状态:

```ts
export function determineVerificationStatus(
  role: string,
  messages: readonly HostToWebviewMessage[],
  status: "completed" | "failed" | "cancelled",
) {
  // 只有 executor 角色需要验证
  if (role !== "executor") {
    return { verificationStatus: "skipped", verificationDetails: "Non-executor role, verification not required" };
  }

  if (status === "failed" || status === "cancelled") {
    return { verificationStatus: "skipped", verificationDetails: "Task did not complete successfully" };
  }

  const detection = detectVerificationFromMessages(messages);

  if (!detection.hasVerification) {
    return {
      verificationStatus: "not-run",
      verificationDetails: "No verification commands detected. Expected test, typecheck, or build commands.",
    };
  }

  if (detection.verificationPassed) {
    return { verificationStatus: "passed", verificationDetails: `Ran: ${detection.verificationCommands.join(", ")}` };
  }

  return { verificationStatus: "failed", verificationDetails: detection.failureReason || "Verification command failed" };
}
```

`not-run` 这个状态最有价值:**executor 完成了任务,但没跑任何验证命令**。

这正好对应 executor 提示词里那句 "Only report the task as completed if verification passes"。提示词是软约束,模型可能无视它然后报告成功。`not-run` 是**事后的硬核对**——从消息流里看你到底跑了没,而不是听你说跑了没。而且 `not-run` 会让 `keepChanges` 为 false,改动**不会被合并**。

`✶ 声明与事实的分离`
这是提示词工程里一个重要模式:**让模型声明,然后独立验证声明**。不要问模型"你跑测试了吗"(它会说跑了),而是去看消息流里有没有 `runCommand("npm test")` 以及它的 `succeeded`。凡是能从执行痕迹里核实的事,就别依赖模型的自我报告。

## 失败时的诊断日志

最后一块。子智能体失败时,主 Agent 需要知道**为什么**,但不能收到几万 token 的完整日志:

```ts
// workflowOrchestrator.ts
const MAX_DIAGNOSTIC_LOG_ENTRIES = 24;
const MAX_DIAGNOSTIC_LOG_CHARS = 800;
const MAX_DIAGNOSTIC_TOTAL_CHARS = 8_000;

export function summarizeSubagentMessages(messages: readonly HostToWebviewMessage[]): WorkflowDiagnosticLog[] {
  const logs: WorkflowDiagnosticLog[] = [];
  let totalChars = 0;

  const append = (log: WorkflowDiagnosticLog): void => {
    if (logs.length >= MAX_DIAGNOSTIC_LOG_ENTRIES || totalChars >= MAX_DIAGNOSTIC_TOTAL_CHARS) return;
    const message = redactDiagnosticText(log.message).slice(0, MAX_DIAGNOSTIC_LOG_CHARS);
    if (!message) return;
    const bounded = { ...log, message };
    const remaining = MAX_DIAGNOSTIC_TOTAL_CHARS - totalChars;
    if (remaining <= 0) return;
    bounded.message = bounded.message.slice(0, remaining);
    logs.push(bounded);
    totalChars += bounded.message.length;
  };
  // ... 遍历消息,按类型 append
}
```

**三重上限**:最多 24 条、每条最多 800 字符、总共最多 8000 字符。三个同时生效,任一触顶就停。

以及脱敏:

```ts
function redactDiagnosticText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
```

子智能体可能读到了 `.env` 文件、可能在命令输出里带出了 token。这些内容如果原样进入主 Agent 的上下文,就会被发给模型提供商。三条正则拦住最常见的形式:OpenAI 风格的 `sk-` key、HTTP `Bearer` 头、`key=value` 形式的凭据。

注意 `diagnosticLog` **只在失败时生成**:

```ts
const diagnosticLog = result.status === "failed" ? summarizeSubagentMessages(entry.messages) : undefined;
```

成功的子智能体只回结论,不回过程——这正是第 01 篇讲的上下文隔离。只有失败时,过程才有诊断价值。

## 系列回顾

六篇下来,多智能体协调的全貌:

```
主 Agent（ReAct 循环）
  │
  │ 工具箱里多了三个:spawnSubagent / waitForSubagents / cancelSubagent
  ↓
WorkflowOrchestrator
  │
  ├─ 图管理:每插一个节点在副本上验一遍(悬空依赖 / 环 / 链长)
  ├─ 调度:pending + 依赖全 completed + executor 不撞车 → 启动
  ├─ 级联:任一节点非 completed → 递归取消所有下游
  ├─ 活性:每 60s 判四态,progressing/blocked 续期,自适应乘数,300s 绝对上限
  ├─ 隔离:executor 拿独立 worktree,工具调用路径重写
  └─ 结算:验证检测 → 决定合并还是丢弃 → 诊断日志脱敏截断
  ↓
子智能体 = 同一个 createReactAgentRunner
  └─ 差异只有三处:工具白名单、角色提示词、错误模式(fail 而非 finish)
```

整个系列里最值得记住的三点:

**一,多智能体不需要新的运行时。** 三个工具 + 一个编排器,主 Agent 的循环一行没改。子智能体就是同一个 ReAct runner。

**二,安全边界建在能力层。** 不是告诉 explorer "别改文件",是不给它 `applyEdit`。提示词是软约束,工具白名单是硬约束。

**三,健康判定不能只看"有没有动静"。** 墙钟会误杀正在跑测试的节点,"有新消息"会把死循环判为健康。需要四态区分、语义化的慢命令识别,以及一堵兜底的绝对墙。

---

## 关于 LoopAgent

本文代码来自 [LoopAgent](https://github.com/oi12344/loopagent-vscode) —— 一个 VS Code AI 编程扩展,带 SQLite FTS5 代码智能索引、语义图、函数调用式 ReAct 循环和本系列讲的多智能体编排。

本文涉及的文件:

- [src/extension/agent/workflow/worktreeManager.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/worktreeManager.ts) — worktree 创建与清理
- [src/extension/agent/workflowOrchestrator.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflowOrchestrator.ts) — 路径重写、结算、诊断日志
- [src/extension/agent/workflow/verificationDetector.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/src/extension/agent/workflow/verificationDetector.ts) — 验证检测

对应测试:[test/workflow/worktreeManager.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/workflow/worktreeManager.test.ts)、[test/agent/worktreeRequestRewrite.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/agent/worktreeRequestRewrite.test.ts)、[test/workflow/verificationDetector.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/workflow/verificationDetector.test.ts)

整个多智能体模块有 13 个测试文件、143 个测试用例。想深入的话,从 [test/workflowOrchestrator.test.ts](https://github.com/oi12344/loopagent-vscode/blob/94c5948fd472a14f51558ac2421e8c42f0d8e0ed/test/workflowOrchestrator.test.ts) 读起最快——它把编排器的每个行为都跑了一遍。

读到这里的话,欢迎给项目点个 star ⭐

**项目地址**:https://github.com/oi12344/loopagent-vscode

---

📖 上一篇:05 · 它是卡住了,还是在干活?
