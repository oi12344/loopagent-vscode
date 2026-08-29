# 工具缓存 + 数据传递链 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现工具结果缓存和工具间数据传递，减少重复调用和模型轮次

**Architecture:** 
1. 工具缓存：基于 toolName + input hash 的 TTL 缓存，跳过相同输入的重复调用
2. 数据传递链：同一步骤内，前一个工具的输出自动传递给下一个工具作为上下文

**Tech Stack:** TypeScript, Map-based caching, SHA-256 hash

**Spec:** 无独立 spec 文件，基于现有 `reactAgentRunner.ts` 工具调用机制扩展

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/extension/agent/toolCache.ts` | 新建：工具结果缓存类 |
| `src/extension/agent/toolChain.ts` | 新建：工具链数据传递逻辑 |
| `src/extension/agent/reactAgentRunner.ts` | 修改：集成缓存和数据传递 |
| `src/extension/agent/reactTypes.ts` | 修改：扩展 invocation 类型 |
| `src/extension/agent/toolRegistry.ts` | 修改：支持上下文传递 |
| `test/toolCache.test.ts` | 新建：缓存单元测试 |
| `test/toolChain.test.ts` | 新建：数据传递单元测试 |

---

## Global Constraints

- 不改变现有工具接口的向后兼容性
- 缓存仅对只读工具生效，写工具（applyEdit, runCommand）不缓存
- 数据传递仅在同一步骤的顺序执行中生效
- 缓存 TTL 默认 5 分钟，可配置

---

### Task 1: 实现工具结果缓存

**Files:**
- Create: `src/extension/agent/toolCache.ts`
- Create: `test/toolCache.test.ts`

**Interfaces:**
- Produces: `ToolResultCache` class with `get()`, `set()`, `has()`, `clear()`

- [ ] **Step 1: 创建缓存类骨架**

```typescript
// src/extension/agent/toolCache.ts
export type CacheEntry = {
  content: string;
  evidence: unknown[];
  productive: boolean;
  cachedAt: number;
};

export type ToolCacheOptions = {
  /** 缓存过期时间（毫秒），默认 5 分钟 */
  ttlMs?: number;
  /** 最大缓存条目数，默认 100 */
  maxEntries?: number;
};

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: ToolCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 100;
  }

  /** 生成缓存 key */
  static cacheKey(toolName: string, input: unknown): string {
    const inputStr = JSON.stringify(input, Object.keys(input as object).sort());
    // 简单 hash：使用字符串长度 + 前 100 字符
    const hash = `${inputStr.length}:${inputStr.slice(0, 100)}`;
    return `${toolName}::${hash}`;
  }

  /** 获取缓存，过期返回 undefined */
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /** 设置缓存 */
  set(key: string, entry: Omit<CacheEntry, "cachedAt">): void {
    // 淘汰最旧条目
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { ...entry, cachedAt: Date.now() });
  }

  /** 检查是否有缓存 */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** 清空缓存 */
  clear(): void {
    this.cache.clear();
  }

  /** 获取缓存大小 */
  get size(): number {
    return this.cache.size;
  }
}
```

- [ ] **Step 2: 编写缓存测试**

```typescript
// test/toolCache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolResultCache } from "../src/extension/agent/toolCache";

describe("ToolResultCache", () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = new ToolResultCache({ ttlMs: 1000, maxEntries: 3 });
  });

  it("生成相同的 cacheKey 对于相同输入", () => {
    const key1 = ToolResultCache.cacheKey("readFile", { path: "foo.ts" });
    const key2 = ToolResultCache.cacheKey("readFile", { path: "foo.ts" });
    expect(key1).toBe(key2);
  });

  it("生成不同的 cacheKey 对于不同输入", () => {
    const key1 = ToolResultCache.cacheKey("readFile", { path: "foo.ts" });
    const key2 = ToolResultCache.cacheKey("readFile", { path: "bar.ts" });
    expect(key1).not.toBe(key2);
  });

  it("缓存过期后返回 undefined", async () => {
    const key = ToolResultCache.cacheKey("readFile", { path: "foo.ts" });
    cache.set(key, { content: "hello", evidence: [], productive: true });
    
    expect(cache.get(key)).toBeDefined();
    
    // 等待过期
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(cache.get(key)).toBeUndefined();
  });

  it("超出 maxEntries 时淘汰最旧条目", () => {
    cache.set("key1", { content: "1", evidence: [], productive: true });
    cache.set("key2", { content: "2", evidence: [], productive: true });
    cache.set("key3", { content: "3", evidence: [], productive: true });
    cache.set("key4", { content: "4", evidence: [], productive: true });
    
    expect(cache.has("key1")).toBe(false);
    expect(cache.has("key4")).toBe(true);
  });

  it("clear 清空所有缓存", () => {
    cache.set("key1", { content: "1", evidence: [], productive: true });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
```

- [ ] **Step 3: 运行测试验证**

Run: `npx vitest run test/toolCache.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extension/agent/toolCache.ts test/toolCache.test.ts
git commit -m "feat: add tool result cache with TTL support"
```

---

### Task 2: 扩展工具调用类型支持上下文传递

**Files:**
- Modify: `src/extension/agent/reactTypes.ts:32-36`
- Modify: `src/extension/agent/toolRegistry.ts:3-6`

**Interfaces:**
- Consumes: `ReactAgentToolInvocation` type
- Produces: 扩展后的类型支持 `context` 字段

- [ ] **Step 1: 扩展 ReactAgentToolInvocation 类型**

```typescript
// src/extension/agent/reactTypes.ts:32-36
export type ReactAgentToolInvocation = {
  request: ReactAgentToolRequest;
  input: unknown;
  signal: AbortSignal;
  /** 前一个工具的输出上下文（同一步骤内传递） */
  context?: string;
};
```

- [ ] **Step 2: 更新 ToolInvoker 类型**

```typescript
// src/extension/agent/toolRegistry.ts:3-6
export type ToolInvoker = (
  request: ReactAgentToolRequest,
  signal: AbortSignal,
  context?: string,
) => Promise<ReactAgentToolResult>;
```

- [ ] **Step 3: 更新 invokeRegisteredTool 支持 context**

```typescript
// src/extension/agent/toolRegistry.ts:16-27
export function invokeRegisteredTool(
  tools: readonly ReactAgentTool[],
  request: ReactAgentToolRequest,
  signal: AbortSignal,
  context?: string,
): Promise<ReactAgentToolResult> {
  const tool = tools.find((candidate) => candidate.name === request.name);
  if (!tool) return Promise.reject(new Error(`Unknown tool: ${request.name}`));

  return Promise.resolve(tool.invoke({ request, input: request.input, signal, context })).then((result) =>
    typeof result === "string" ? { content: result, evidence: [] } : result,
  );
}
```

- [ ] **Step 4: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extension/agent/reactTypes.ts src/extension/agent/toolRegistry.ts
git commit -m "feat: extend tool invocation type to support context passing"
```

---

### Task 3: 实现工具链数据传递逻辑

**Files:**
- Create: `src/extension/agent/toolChain.ts`
- Create: `test/toolChain.test.ts`

**Interfaces:**
- Produces: `ToolChainExecutor` class for managing tool execution with context passing

- [ ] **Step 1: 创建工具链执行器**

```typescript
// src/extension/agent/toolChain.ts
import type { ReactAgentToolRequest, ReactAgentToolResult } from "./reactTypes";

export type ToolInvoker = (
  request: ReactAgentToolRequest,
  signal: AbortSignal,
  context?: string,
) => Promise<ReactAgentToolResult>;

export type ToolChainStep = {
  request: ReactAgentToolRequest;
  result?: ReactAgentToolResult;
};

/**
 * 工具链执行器：在同一步骤内顺序执行工具，并将前一个工具的输出传递给下一个工具
 */
export class ToolChainExecutor {
  private readonly invokeTool: ToolInvoker;
  private steps: ToolChainStep[] = [];

  constructor(invokeTool: ToolInvoker) {
    this.invokeTool = invokeTool;
  }

  /**
   * 添加工具调用到链中
   */
  addStep(request: ReactAgentToolRequest): void {
    this.steps.push({ request });
  }

  /**
   * 执行整个工具链，前一个工具的输出会传递给下一个工具
   */
  async execute(signal: AbortSignal): Promise<ReactAgentToolResult[]> {
    const results: ReactAgentToolResult[] = [];
    let previousOutput: string | undefined;

    for (const step of this.steps) {
      const result = await this.invokeTool(step.request, signal, previousOutput);
      step.result = result;
      results.push(result);
      previousOutput = result.content;
    }

    return results;
  }

  /**
   * 获取某个步骤的上下文（前一个工具的输出）
   */
  getContextForStep(index: number): string | undefined {
    if (index <= 0) return undefined;
    return this.steps[index - 1]?.result?.content;
  }

  /**
   * 清空步骤
   */
  clear(): void {
    this.steps = [];
  }
}
```

- [ ] **Step 2: 编写工具链测试**

```typescript
// test/toolChain.test.ts
import { describe, it, expect, vi } from "vitest";
import { ToolChainExecutor } from "../src/extension/agent/toolChain";
import type { ReactAgentToolRequest } from "../src/extension/agent/reactTypes";

describe("ToolChainExecutor", () => {
  it("按顺序执行工具并传递上下文", async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({ content: "file content", evidence: [], productive: true })
      .mockResolvedValueOnce({ content: "review result", evidence: [], productive: true });

    const executor = new ToolChainExecutor(invokeTool);

    const request1: ReactAgentToolRequest = {
      id: "1",
      name: "readFile",
      rawArguments: '{"path":"foo.ts"}',
      input: { path: "foo.ts" },
    };

    const request2: ReactAgentToolRequest = {
      id: "2",
      name: "codeReview",
      rawArguments: '{"content":"file content"}',
      input: { content: "file content" },
    };

    executor.addStep(request1);
    executor.addStep(request2);

    const results = await executor.execute(new AbortController().signal);

    expect(results).toHaveLength(2);
    expect(invokeTool).toHaveBeenCalledTimes(2);
    
    // 第二个工具收到第一个工具的输出作为 context
    expect(invokeTool).toHaveBeenNthCalledWith(2, request2, expect.any(AbortSignal), "file content");
  });

  it("getContextForStep 返回前一步的输出", async () => {
    const invokeTool = vi.fn()
      .mockResolvedValue({ content: "output", evidence: [], productive: true });

    const executor = new ToolChainExecutor(invokeTool);

    executor.addStep({ id: "1", name: "tool1", rawArguments: "{}", input: {} });
    executor.addStep({ id: "2", name: "tool2", rawArguments: "{}", input: {} });

    await executor.execute(new AbortController().signal);

    expect(executor.getContextForStep(0)).toBeUndefined();
    expect(executor.getContextForStep(1)).toBe("output");
  });
});
```

- [ ] **Step 3: 运行测试验证**

Run: `npx vitest run test/toolChain.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extension/agent/toolChain.ts test/toolChain.test.ts
git commit -m "feat: add tool chain executor for context passing between tools"
```

---

### Task 4: 集成缓存和数据传递到 React Agent Runner

**Files:**
- Modify: `src/extension/agent/reactAgentRunner.ts:278-350`

**Interfaces:**
- Consumes: `ToolResultCache`, `ToolChainExecutor`
- Produces: 修改后的工具调用流程

- [ ] **Step 1: 在 runner 中创建缓存实例**

在 `createReactAgentRunner` 函数内部（约第 60 行）添加：

```typescript
const toolCache = new ToolResultCache({ ttlMs: 5 * 60 * 1000 });

/** 只读工具列表（可缓存） */
const READ_ONLY_TOOLS = new Set([
  "exploreCode", "browseSymbols", "readFile", "listDirectory",
  "analyzeImage", "codeReview",
]);
```

- [ ] **Step 2: 修改 invoke 函数使用缓存**

替换 `reactAgentRunner.ts` 第 278-302 行的 `invoke` 函数：

```typescript
const invoke = async (
  toolRequest: ReactAgentToolRequest,
  context?: string,
) => {
  if (!toolsByName.has(toolRequest.name)) {
    return { content: `Tool error: Unknown tool "${toolRequest.name}"`, succeeded: false, productive: false, evidence: [] as MemoryEvidence[] };
  }
  if (toolRequest.parseError) {
    return { content: `Tool error: ${toolRequest.parseError}`, succeeded: false, productive: false, evidence: [] as MemoryEvidence[] };
  }

  // 检查重复调用
  const signature = computeToolCallSignature(toolRequest);
  const cached = succeededCalls.get(signature);
  if (cached !== undefined) {
    return {
      content: `重复调用：已用相同参数调用过 ${toolRequest.name}，上次结果：${cached}。请改变查询或给出最终答案。`,
      succeeded: false,
      productive: false,
      evidence: [] as MemoryEvidence[],
    };
  }

  // 检查工具缓存（仅只读工具）
  if (READ_ONLY_TOOLS.has(toolRequest.name)) {
    const cacheKey = ToolResultCache.cacheKey(toolRequest.name, toolRequest.input);
    const cachedResult = toolCache.get(cacheKey);
    if (cachedResult) {
      return {
        content: `[缓存] ${cachedResult.content}`,
        succeeded: true,
        productive: cachedResult.productive,
        evidence: cachedResult.evidence as MemoryEvidence[],
      };
    }
  }

  try {
    const result = await invokeTool(toolRequest, signal, context);
    
    // 写入缓存（仅只读工具）
    if (READ_ONLY_TOOLS.has(toolRequest.name)) {
      const cacheKey = ToolResultCache.cacheKey(toolRequest.name, toolRequest.input);
      toolCache.set(cacheKey, {
        content: result.content,
        evidence: result.evidence,
        productive: result.productive ?? true,
      });
    }

    return { content: result.content, succeeded: true, productive: result.productive ?? true, evidence: result.evidence };
  } catch (error) {
    return { content: `Tool error: ${formatRunError(error)}`, succeeded: false, productive: false, evidence: [] as MemoryEvidence[] };
  }
};
```

- [ ] **Step 3: 修改批量执行支持上下文传递**

替换 `reactAgentRunner.ts` 第 303-321 行的批量执行逻辑：

```typescript
const outcomes: Array<{ content: string; succeeded: boolean; productive: boolean; evidence: MemoryEvidence[] }> = [];

if (batch.concurrent) {
  // 并发执行：无上下文传递
  const duplicateInBatch = new Set<string>();
  const results = await Promise.all(
    batch.requests.map(({ request }) => {
      const signature = computeToolCallSignature(request);
      if (duplicateInBatch.has(signature)) {
        return {
          content: `重复调用：同批次内已存在相同参数的 ${request.name} 调用，请改变查询或给出最终答案。`,
          succeeded: false,
          productive: false,
          evidence: [] as MemoryEvidence[],
        };
      }
      duplicateInBatch.add(signature);
      return invoke(request);
    }),
  );
  outcomes.push(...results);
} else {
  // 顺序执行：传递上下文
  let previousOutput: string | undefined;
  for (const { request } of batch.requests) {
    const result = await invoke(request, previousOutput);
    outcomes.push(result);
    if (result.succeeded && result.productive) {
      previousOutput = result.content;
    }
  }
}
```

- [ ] **Step 4: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 运行现有测试验证无回归**

Run: `npx vitest run test/reactAgentRunner.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/extension/agent/reactAgentRunner.ts
git commit -m "feat: integrate tool cache and context passing into agent runner"
```

---

### Task 5: 添加缓存命中率统计

**Files:**
- Modify: `src/extension/agent/toolCache.ts`
- Modify: `src/extension/agent/reactAgentRunner.ts`

**Interfaces:**
- Produces: 缓存统计信息输出

- [ ] **Step 1: 添加统计方法到 ToolResultCache**

```typescript
// src/extension/agent/toolCache.ts 添加方法
export type CacheStats = {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
};

export class ToolResultCache {
  private hits = 0;
  private misses = 0;

  // ... 现有代码 ...

  /** 获取缓存统计 */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}
```

- [ ] **Step 2: 在 runner 中记录统计**

在 `reactAgentRunner.ts` 的 ReAct 循环结束后（约第 390 行）添加：

```typescript
// 输出缓存统计
const cacheStats = toolCache.getStats();
if (cacheStats.hits > 0 || cacheStats.misses > 0) {
  console.log(`[ReactAgent] Tool cache: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${(cacheStats.hitRate * 100).toFixed(1)}% hit rate)`);
}
```

- [ ] **Step 3: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extension/agent/toolCache.ts src/extension/agent/reactAgentRunner.ts
git commit -m "feat: add tool cache hit rate statistics"
```

---

### Task 6: 集成测试验证

**Files:**
- Modify: `test/reactAgentRunner.test.ts`

**Interfaces:**
- Consumes: 完整的缓存和数据传递功能

- [ ] **Step 1: 添加缓存行为测试**

```typescript
// test/reactAgentRunner.test.ts 添加测试
it("caches read-only tool results and returns cached content on repeat calls", async () => {
  let callCount = 0;
  const mockModelTurn = vi.fn().mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        kind: "toolRequests",
        assistantMessage: { role: "assistant", content: "", toolCalls: [] },
        requests: [{
          id: "call-1",
          name: "readFile",
          rawArguments: '{"path":"test.ts"}',
          input: { path: "test.ts" },
        }],
      };
    }
    return { kind: "final", content: "Done" };
  });

  const runner = createReactAgentRunner({
    modelTurn: mockModelTurn,
    tools: [{
      name: "readFile",
      description: "Read file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      invoke: vi.fn().mockResolvedValue({ content: "file content", evidence: [] }),
    }],
  });

  // 第一次调用
  const events1 = [];
  for await (const event of runner.run({ runId: "1", task: "read test.ts", signal: new AbortController().signal })) {
    events1.push(event);
  }

  // 第二次调用相同参数 - 应该命中缓存
  const events2 = [];
  for await (const event of runner.run({ runId: "2", task: "read test.ts", signal: new AbortController().signal })) {
    events2.push(event);
  }

  // 验证缓存命中（第二次不应该调用工具）
  expect(mockModelTurn).toHaveBeenCalledTimes(3); // 2 次 toolRequests + 1 次 final
});
```

- [ ] **Step 2: 运行测试验证**

Run: `npx vitest run test/reactAgentRunner.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/reactAgentRunner.test.ts
git commit -m "test: add integration tests for tool caching"
```

---

## 验证清单

完成所有任务后：

1. `npm run typecheck` - 类型检查通过
2. `npx vitest run test/toolCache.test.ts` - 缓存测试通过
3. `npx vitest run test/toolChain.test.ts` - 工具链测试通过
4. `npx vitest run test/reactAgentRunner.test.ts` - 现有测试无回归
5. 手动测试：上传图片 → Agent 调用 analyzeImage → 再次调用时应命中缓存
