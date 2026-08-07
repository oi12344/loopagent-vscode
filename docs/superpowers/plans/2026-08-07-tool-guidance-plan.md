# 工具 guidance 下沉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工具专属使用说明从 `providerRegistry.ts` 下沉到各工具定义中的 `guidance` 字段，并让系统提示词自动从当前工具列表聚合这些说明。

**Architecture:** `ReactAgentTool` 只增加一个可选的 `guidance` 元数据字段，各工具在工厂函数里声明自己的使用建议。`providerRegistry.ts` 负责把当前 runner 实际可用的工具 guidance 拼进系统提示词，父 runner 和 workflow 子 runner 走同一套提示词构建逻辑，避免再次手写工具清单。系统提示词继续保留与工具无关的通用原则和运行时上下文碎片。

**Tech Stack:** TypeScript, Vitest, VS Code extension host abstractions.

## Global Constraints

- 不改工具输入 schema
- 不改工具执行逻辑
- 不改模型返回协议
- 不引入单独的 prompt registry 或配置文件

## 文件边界

- `src/extension/agent/reactTypes.ts`：工具契约，新增 `guidance` 元数据字段。
- `src/extension/agent/browseSymbolsTool.ts`、`src/extension/agent/exploreCodeTool.ts`、`src/extension/agent/listDirectoryTool.ts`、`src/extension/agent/readFileTool.ts`、`src/extension/agent/applyEditTool.ts`、`src/extension/agent/runCommandTool.ts`：各工具自己的使用说明。
- `src/extension/model/providerRegistry.ts`：系统提示词拼接，聚合当前工具的 guidance，并让父 runner 与 workflow 子 runner 共用同一套构建逻辑。
- `test/toolGuidanceAggregation.test.ts`：新增 guidance 聚合回归测试。
- `test/providerRegistryCodeContext.test.ts`：保留现有行为回归，必要时补一条 workflow 路径断言。

---

### Task 1: 先把工具契约扩上，并写出能证明问题存在的红灯测试

**Files:**
- Modify: `src/extension/agent/reactTypes.ts`
- Create: `test/toolGuidanceAggregation.test.ts`

**Interfaces:**
- Consumes: `ReactAgentTool` objects passed into `createConfiguredAgentRunner`
- Produces: `ReactAgentTool.guidance?: string[]`，以及一条会在当前实现下失败的回归测试

- [ ] **Step 1: 给工具契约加上 guidance 字段**

在 `ReactAgentTool` 上增加可选字段：

```ts
export type ReactAgentTool = {
  name: string;
  description: string;
  guidance?: string[];
  inputSchema: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  isConcurrencySafe?: (input: unknown) => boolean;
  invoke(invocation: ReactAgentToolInvocation): string | ReactAgentToolResult | Promise<string | ReactAgentToolResult>;
};
```

- [ ] **Step 2: 写一个只看系统提示词的集成测试**

在 `test/toolGuidanceAggregation.test.ts` 里，mock `createDeepSeekProvider` 去捕获传给模型的 `messages`，然后把一个带 `guidance` 的假工具通过 `extraTools` 注入 `createConfiguredAgentRunner`。

```ts
const guidedTool: ReactAgentTool = {
  name: "guidedTool",
  description: "A fake tool used to prove prompt aggregation.",
  guidance: ["Use guidedTool only when you need the guided result."],
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async invoke() {
    return "guided result";
  },
};

const systemPrompt = capturedMessages[0]!
  .filter((message) => message.role === "system")
  .map((message) => message.content)
  .join("\n\n");

expect(systemPrompt).toContain("Use guidedTool only when you need the guided result.");
```

- [ ] **Step 3: 运行这一个测试，确认它先红起来**

运行：

```text
npm test -- test/toolGuidanceAggregation.test.ts
```

预期：测试文件可以编译，但断言失败，因为当前系统提示词还在使用写死的 `DIRECT_TOOL_GUIDANCE`。

### Task 2: 把工具专属说明搬回工具定义，并让父/子 runner 共用同一套提示词拼接

**Files:**
- Modify: `src/extension/agent/browseSymbolsTool.ts`
- Modify: `src/extension/agent/exploreCodeTool.ts`
- Modify: `src/extension/agent/listDirectoryTool.ts`
- Modify: `src/extension/agent/readFileTool.ts`
- Modify: `src/extension/agent/applyEditTool.ts`
- Modify: `src/extension/agent/runCommandTool.ts`
- Modify: `src/extension/model/providerRegistry.ts`
- Modify: `test/toolGuidanceAggregation.test.ts`

**Interfaces:**
- Consumes: `ReactAgentTool.guidance`，以及 `createConfiguredAgentRunner` 现有的 parent / workflow runner 创建路径
- Produces: `providerRegistry.ts` 内部的共享提示词构建逻辑；父 runner 和 workflow 子 runner 都从当前可用工具列表聚合 guidance

- [ ] **Step 1: 把 `DIRECT_TOOL_GUIDANCE` 中的工具专属文本迁移到各工具文件**

迁移时保持 `description` 只做简短、事实性的工具说明，把“什么时候用、先后顺序、别用什么”放到 `guidance` 里。

代表性的落点如下：

```ts
// browseSymbolsTool.ts
return {
  name: "browseSymbols",
  description: "List symbol names in the workspace that match a concept or partial name.",
  guidance: [
    "When you do not know what symbols exist in the codebase, call browseSymbols with a concept or partial name first to discover actual identifiers.",
    "When symbols are already known, call exploreCode directly with a concise, code-oriented query using likely English identifiers.",
    "Trace behavior from current production entry points. Ignore historical documents, tests, and unreferenced legacy modules unless the user explicitly asks about them.",
  ],
  ...
};
```

对其余工具按同样模式迁移：

- `exploreCodeTool.ts`：保留“已知符号时直接查代码”“证据够了就停”“不要重复问同一个缺口”
- `listDirectoryTool.ts`：保留“探索目录结构时优先用它，不要回退到 shell ls/dir”
- `readFileTool.ts`：保留“编辑前先读文件内容”
- `applyEditTool.ts`：保留“读完相关文件后再提交完整编辑方案”
- `runCommandTool.ts`：保留“自动恢复、后台执行、失败后优先读取 alternatives”的说明

- [ ] **Step 2: 在 `providerRegistry.ts` 里引入共享提示词构建函数**

把写死的 `DIRECT_TOOL_GUIDANCE` 删除，改成先从当前工具数组收集 guidance，再和通用原则、运行时上下文、任务分类信息一起拼接。

```ts
function collectToolGuidance(tools: readonly ReactAgentTool[]): string[] {
  return tools.flatMap((tool) => tool.guidance ?? []);
}

function buildSystemPrompt(
  basePrompt: string,
  tools: readonly ReactAgentTool[],
  fragments: {
    taskGuidance?: string;
    runtimePrompt?: string;
    memoryPrompt?: string;
    imagePrompt?: string;
  } = {},
): string {
  return [
    basePrompt,
    fragments.taskGuidance,
    collectToolGuidance(tools).join("\n"),
    fragments.runtimePrompt,
    fragments.memoryPrompt,
    fragments.imagePrompt,
  ].filter(Boolean).join("\n\n");
}
```

然后把它接到两条路径上：

- `createParentRunner(...)`：继续拼接 `taskGuidance`、`runtimePrompt`、`memoryPrompt`、`imagePrompt`，但工具说明从 `tools` 动态聚合
- workflow 的 `createRunner(...)`：对子 runner 也走同一个 `buildSystemPrompt(...)`，只把 `childProfile.systemPrompt`、`childTools` 和该子 runner 可用的运行时碎片传进去

- [ ] **Step 3: 在同一个测试文件里补一个 workflow 路径断言**

把 `test/toolGuidanceAggregation.test.ts` 扩成两条断言：

1. parent runner 的系统提示词包含 `extraTools` 的 guidance
2. workflow 子 runner 的系统提示词只包含它实际拿到的工具 guidance，不再依赖 `providerRegistry.ts` 里的全局写死清单

如果 workflow 路径的断言要借助 mock `createReactAgentRunner` 或捕获子 runner 的 `systemPromptProvider`，就把它写在这个测试文件里，避免把断言分散到多个地方。

- [ ] **Step 4: 运行定向测试确认 GREEN**

运行：

```text
npm test -- test/toolGuidanceAggregation.test.ts test/providerRegistryCodeContext.test.ts
```

预期：新的 guidance 回归测试和现有 providerRegistry 上下文测试都通过。

### Task 3: 做最终验证并提交这次重构

**Files:**
- Modify: 无新业务文件；只做验证和提交

**Interfaces:**
- Consumes: Task 1、Task 2 产出的工具契约和提示词聚合逻辑
- Produces: 可提交的干净工作区和一个描述清楚的 commit

- [ ] **Step 1: 跑最终验证**

运行：

```text
npm run compile
npm test -- test/toolGuidanceAggregation.test.ts test/providerRegistryCodeContext.test.ts
git diff --check
```

- [ ] **Step 2: 只保留和本次重构相关的改动**

确认没有把临时调试文件、无关文档或其他正在进行的工作一起带进来；如果 workflow 路径的断言还不够精确，就在这里收紧断言，而不是放宽 prompt。

- [ ] **Step 3: 提交**

```bash
git add src/extension/agent/reactTypes.ts src/extension/agent/browseSymbolsTool.ts src/extension/agent/exploreCodeTool.ts src/extension/agent/listDirectoryTool.ts src/extension/agent/readFileTool.ts src/extension/agent/applyEditTool.ts src/extension/agent/runCommandTool.ts src/extension/model/providerRegistry.ts test/toolGuidanceAggregation.test.ts
git commit -m "refactor: move tool guidance into tool definitions"
```
