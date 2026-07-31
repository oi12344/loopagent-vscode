# 提示词分层设计与实现

## 当前问题分析

### 问题 1: 系统提示可能被压缩

**当前代码：**
```typescript
// reactAgentRunner.ts
const compressed = compressConversationHistory(messages, {
  maxMessages: 50,
  keepRecentMessages: 20,
});
messages.splice(0, messages.length, ...compressed);
```

**问题：**
- `messages` 数组包含 `[system, ...history, user, assistant, tool, ...]`
- `compressConversationHistory` 虽然保留系统提示，但压缩逻辑在 runner 层面应该更明确

### 问题 2: 分层不够清晰

**当前结构：**
```typescript
messages = [
  { role: "system", content: basePrompt + runtimePrompt + memoryPrompt + imagePrompt },
  ...conversationHistory,
  { role: "user", content: task },
  { role: "assistant", content: "...", toolCalls: [...] },
  { role: "tool", content: "..." },
  ...
]
```

**问题：**
- 所有内容混在一个数组里
- 压缩时无法区分"永久内容"和"临时内容"
- 系统提示内部的分层（basePrompt, runtimePrompt, memoryPrompt）被串联成一个字符串

---

## 理想的分层架构

### 分层定义

```typescript
type MessageLayer = 
  | "system"           // L1: 系统级规则（永久保留）
  | "runtime"          // L2: 运行时上下文（会话级）
  | "memory"           // L3: 项目记忆（项目级）
  | "conversation"     // L4: 对话历史（可压缩）
  | "tool"             // L5: 工具返回（最先压缩）

type LayeredMessage = ReactAgentMessage & {
  layer?: MessageLayer;
  priority?: number;  // 同层内的优先级
}
```

### 压缩优先级

```
优先级（高 → 低）：
1. system (L1) - 永久保留
2. runtime (L2) - 会话期保留
3. memory (L3) - 项目相关保留
4. conversation (L4) - 压缩为摘要
5. tool (L5) - 最先丢弃（保留最近 N 个）
```

### 压缩策略

```typescript
function layeredCompression(messages: LayeredMessage[]): LayeredMessage[] {
  const layers = {
    system: messages.filter(m => m.layer === "system"),
    runtime: messages.filter(m => m.layer === "runtime"),
    memory: messages.filter(m => m.layer === "memory"),
    conversation: messages.filter(m => m.layer === "conversation"),
    tool: messages.filter(m => m.layer === "tool"),
  };

  // L1-L3: 永久保留
  const preserved = [...layers.system, ...layers.runtime, ...layers.memory];

  // L4: 对话历史压缩（保留最近 N 轮）
  const recentConversation = layers.conversation.slice(-20);
  const oldConversation = layers.conversation.slice(0, -20);
  const conversationSummary = oldConversation.length > 0
    ? [{ role: "user", content: summarize(oldConversation), layer: "conversation" }]
    : [];

  // L5: 工具调用只保留最近 M 个
  const recentTools = layers.tool.slice(-10);

  return [
    ...preserved,
    ...conversationSummary,
    ...recentConversation,
    ...recentTools,
  ];
}
```

---

## 当前实现的优化建议

### 方案 A: 最小改动（推荐）

**只需修改 `messageCompression.ts`，明确保护系统层：**

```typescript
export function compressConversationHistory(
  messages: ReactAgentMessage[],
  options: Partial<MessageCompressionOptions> = {},
): ReactAgentMessage[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length <= opts.maxMessages) {
    return messages;
  }

  const compressed: ReactAgentMessage[] = [];

  // 1. 保护所有系统消息（可能有多条）
  const systemMessages = messages.filter((m) => m.role === "system");
  compressed.push(...systemMessages);

  // 2. 找到第一个非系统消息的索引
  const firstNonSystemIndex = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystemIndex === -1) {
    return messages; // 全是系统消息，直接返回
  }

  // 3. 非系统消息部分应用压缩
  const nonSystemMessages = messages.slice(firstNonSystemIndex);
  const keepFromIndex = Math.max(0, nonSystemMessages.length - opts.keepRecentMessages);

  // 压缩中间消息
  const middleMessages = nonSystemMessages.slice(0, keepFromIndex);
  if (middleMessages.length > 0) {
    const summary = summarizeMessages(middleMessages);
    compressed.push({
      role: "user",
      content: `[对话历史摘要: 已省略 ${middleMessages.length} 条消息]\n\n${summary}`,
    });
  }

  // 保留最近消息
  const recentMessages = nonSystemMessages.slice(keepFromIndex);
  compressed.push(...recentMessages);

  return compressed;
}
```

**优点：**
- ✅ 改动最小（只修改一个文件）
- ✅ 向后兼容（API 不变）
- ✅ 保护所有系统消息

### 方案 B: 分层标记（理想但工作量大）

**1. 修改消息类型定义：**

```typescript
// reactTypes.ts
export type MessageLayer = "system" | "runtime" | "memory" | "conversation" | "tool";

export type ReactAgentMessage =
  | {
      role: "system" | "user";
      content: string;
      layer?: MessageLayer;  // 新增
    }
  | {
      role: "assistant";
      content: string;
      reasoningContent?: string;
      toolCalls?: ModelToolCall[];
      layer?: MessageLayer;  // 新增
    }
  | {
      role: "tool";
      requestId: string;
      name: string;
      content: string;
      layer?: MessageLayer;  // 新增
    };
```

**2. 在创建消息时标记层级：**

```typescript
// reactAgentRunner.ts
if (systemPrompt) {
  messages.push({ 
    role: "system", 
    content: systemPrompt,
    layer: "system"  // 标记为系统层
  });
}

for (const historyMsg of conversationHistory) {
  messages.push({
    role: historyMsg.role,
    content: historyMsg.content,
    layer: "conversation",  // 标记为对话层
    ...(historyMsg.reasoning ? { reasoningContent: historyMsg.reasoning } : {}),
  });
}

// 工具返回标记为工具层
messages.push({
  role: "tool",
  requestId: request.id,
  name: request.name,
  content,
  layer: "tool",  // 标记为工具层
});
```

**3. 实现分层压缩：**

```typescript
// layeredCompression.ts
export function layeredCompression(messages: ReactAgentMessage[]): ReactAgentMessage[] {
  // 按层分组
  const byLayer = {
    system: messages.filter(m => m.layer === "system" || (m.role === "system" && !m.layer)),
    runtime: messages.filter(m => m.layer === "runtime"),
    memory: messages.filter(m => m.layer === "memory"),
    conversation: messages.filter(m => m.layer === "conversation" || !m.layer),
    tool: messages.filter(m => m.layer === "tool"),
  };

  // L1-L3: 完全保留
  const preserved = [
    ...byLayer.system,
    ...byLayer.runtime,
    ...byLayer.memory,
  ];

  // L4: 对话历史压缩
  const recentConversation = byLayer.conversation.slice(-20);
  const oldConversation = byLayer.conversation.slice(0, -20);
  const conversationSummary = oldConversation.length > 0
    ? [{
        role: "user" as const,
        content: `[历史对话摘要: ${oldConversation.length} 条消息]\n${summarize(oldConversation)}`,
        layer: "conversation" as const,
      }]
    : [];

  // L5: 工具调用只保留最近 10 个
  const recentTools = byLayer.tool.slice(-10);

  return [
    ...preserved,
    ...conversationSummary,
    ...recentConversation,
    ...recentTools,
  ];
}
```

**优点：**
- ✅ 分层清晰，易于理解
- ✅ 压缩策略精确（不同层不同策略）
- ✅ 可扩展（未来可以添加新层）

**缺点：**
- ❌ 改动大（涉及多个文件）
- ❌ 向后兼容需要处理（layer 是可选的）
- ❌ 测试工作量大

---

## 当前实现中的分层（providerRegistry.ts）

**系统提示组成：**
```typescript
const systemPrompt = [
  basePrompt,        // L1: 基础规则（反幻觉、工具使用规则等）
  runtimePrompt,     // L2: 运行时上下文（工作区路径、git 状态等）
  memoryPrompt,      // L3: 项目记忆（项目特定知识）
  imagePrompt,       // L2: 图片分析结果（会话级）
].filter(Boolean).join("\n\n");
```

**问题：**
- 这些内容被串联成一个大字符串
- 无法单独压缩或丢弃某一层
- 全部放在 `role: "system"` 里

**优化建议：**

### 选项 1: 保持单个 system 消息（当前方式）

**优点：**
- 实现简单
- 兼容所有 API

**缺点：**
- 无法单独管理各层
- 系统提示可能很长（全部计入上下文）

### 选项 2: 拆分为多个 system 消息

```typescript
messages.push(
  { role: "system", content: basePrompt, layer: "system" },
  { role: "system", content: runtimePrompt, layer: "runtime" },
  { role: "system", content: memoryPrompt, layer: "memory" },
  { role: "system", content: imagePrompt, layer: "runtime" },
);
```

**优点：**
- 可以单独管理
- 压缩时可以选择性保留

**缺点：**
- 某些 API 可能不支持多个 system 消息
- 需要验证 DeepSeek 等模型的兼容性

### 选项 3: 使用 user 消息模拟分层

```typescript
messages.push(
  { role: "system", content: basePrompt },  // 核心规则
  { role: "user", content: `[运行时上下文]\n${runtimePrompt}` },
  { role: "assistant", content: "已理解运行时上下文。" },
  { role: "user", content: `[项目记忆]\n${memoryPrompt}` },
  { role: "assistant", content: "已加载项目记忆。" },
);
```

**优点：**
- 兼容性好
- 可以单独压缩或丢弃

**缺点：**
- 浪费 token（需要助手回复）
- 可能影响模型行为

---

## 推荐实施方案

### 短期（立即实施）

**采用方案 A：最小改动保护系统消息**

1. 修改 `messageCompression.ts` 保护所有 system 消息
2. 添加测试验证多个 system 消息的情况
3. 文档中明确说明分层概念

**预期效果：**
- ✅ 系统提示永久保留
- ✅ 改动最小
- ✅ 向后兼容

### 中期（2-4 周）

**调研并实验方案 B：分层标记**

1. 在测试环境中实验分层标记
2. 验证 DeepSeek 等模型对多 system 消息的支持
3. 评估性能影响（token 使用、压缩效果）

### 长期（1-2 个月）

**如果中期实验效果好，全面实施分层架构**

1. 添加 `layer` 字段到消息类型
2. 实现 `layeredCompression` 函数
3. 逐步迁移现有代码使用分层
4. 添加监控指标（各层 token 使用量）

---

## 分层压缩的最佳实践

### 1. 分层原则

```
越靠近"规则"的内容 → 优先级越高
越靠近"数据"的内容 → 优先级越低
```

**示例：**
- 高优先级：反幻觉规则、工具使用规范
- 中优先级：运行时上下文、项目记忆
- 低优先级：对话历史、工具返回

### 2. 压缩时机

```
触发条件：messages.length > 阈值 OR estimatedTokens > 阈值
压缩频率：每步开始前检查
压缩粒度：按层压缩，不是一刀切
```

### 3. 摘要策略

**L4 对话历史：**
- 统计型摘要（X 个问题，Y 次工具调用）
- 提取关键决策（修改了哪些文件，运行了什么测试）

**L5 工具返回：**
- 只保留最近 N 个完整结果
- 旧的工具结果可以只保留摘要（"readFile: src/test.ts, 200 行"）

### 4. 监控指标

```typescript
const metrics = {
  totalTokens: 0,
  tokensByLayer: {
    system: 0,
    runtime: 0,
    memory: 0,
    conversation: 0,
    tool: 0,
  },
  compressionCount: 0,
  avgCompressionRatio: 0,
};
```

---

## 总结

### 当前状态
- ✅ 已有基础压缩逻辑
- ⚠️ 系统提示保护不够明确
- ❌ 缺乏显式的分层概念

### 立即行动
1. **修复系统提示保护**（方案 A）
2. 添加测试验证
3. 更新文档说明分层思想

### 未来演进
- 调研分层标记（方案 B）
- 实验多 system 消息
- 评估性能收益

**分层不是为了炫技，而是为了精确控制上下文预算的分配。**
