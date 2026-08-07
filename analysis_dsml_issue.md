# yguc 工作区对话返回 XML (DSML) 的根本原因分析

## 问题现象

最近一次对话（`conv-1786089715007-b30af176`）中，用户请求"新增一个新增物流信息接口"，assistant 返回了以下内容：

```xml
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="readFile">
<｜｜DSML｜｜parameter name="path" string="true">yguc-biz/src/main/java/com/sunshine/procurement/service/LogisticsService.java</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
<｜｜DSML｜｜invoke name="readFile">
<｜｜DSML｜｜parameter name="path" string="true">yguc-biz/src/main/java/com/sunshine/procurement/vo/LogisticsAddVO.java</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
```

这些内容以**纯文本**形式存储在 `messages_json` 的 `content` 字段中，而非被解析成实际的工具调用。

## 根本原因

### 1. DeepSeek 模型的 DSML 原生格式

- **DSML** 是 DeepSeek 模型的原生工具调用标记格式
- 标签中使用**全角竖线** `｜` (U+FF5C)，而非普通竖线 `|` (U+007C)
- 这是 DeepSeek 模型在**文本生成模式**下输出工具调用的方式

### 2. OpenAI 兼容 API 期望的响应格式

根据 `src/extension/model/openAiCompatibleClient.ts:245-277`，系统期望从 SSE 流中接收：

```typescript
type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string;              // 普通文本内容
      reasoning_content?: string;     // 推理内容
      tool_calls?: Array<{            // 结构化工具调用
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
};
```

**关键点**：工具调用应该出现在 `delta.tool_calls` 数组中，而不是 `delta.content` 文本字段。

### 3. 问题触发条件

查看 `src/extension/model/providers/deepseekProvider.ts:33-36`：

```typescript
const requestThinking = request.toolChoice === "required" || typeof request.toolChoice === "object"
  ? "disabled"
  : thinking;  // 默认 "enabled"
```

**问题链条**：

1. 当 `toolChoice` 为 `"auto"` 时，`thinking` 参数保持为 `"enabled"`
2. DeepSeek API 同时启用思考模式 + 工具调用时
3. 模型可能以**文本生成模式**输出 DSML 标记，而不是调用 API 层的结构化工具调用接口
4. API 返回的 SSE chunk 中，`delta.content` 包含 DSML 文本，而 `delta.tool_calls` 为空
5. `openAiReactModelTurn.ts:50-52` 只处理 `contentDelta` 和 `toolCallDelta`
6. DSML 文本被当作普通内容累积到 `content` 变量中
7. 最终返回 `{ kind: "final", content: "<DSML 文本>" }` 而不是 `{ kind: "toolRequests", ... }`

### 4. 为何没有被解析

系统架构中**没有**任何 DSML 文本解析器：

- `grep -rn "DSML"` 仅在 `exploreCodeTool.ts:71` 发现一处格式检测引用
- `openAiReactModelTurn.ts` 完全依赖 API 返回的结构化 `tool_calls`
- 不存在从 `content` 中提取 DSML 标记的后备逻辑

## 解决方案

### 方案 A：禁用思考模式（当前推荐）

修改 `deepseekProvider.ts:33-36`：

```typescript
// 工具调用时始终禁用思考模式，避免 DSML 文本泄漏
const requestThinking = "disabled";
```

**优点**：
- 简单可靠
- 避免思考模式与工具调用的兼容性问题

**缺点**：
- 失去思考链推理能力

### 方案 B：实现 DSML 降级解析器

在 `openAiReactModelTurn.ts` 中添加后备逻辑：

```typescript
if (content.length > 0) {
  // 检测 DSML 标记
  if (content.includes('<｜｜DSML｜｜tool_calls>')) {
    const toolRequests = parseDsmlToolCalls(content);
    if (toolRequests.length > 0) {
      return { kind: "toolRequests", assistantMessage: {...}, requests: toolRequests };
    }
  }
  
  if (toolChoice === "required" || typeof toolChoice === "object") {
    throw new Error("Model did not call a required tool");
  }
  return { kind: "final", content, ...(reasoning ? { reasoning } : {}) };
}
```

**优点**：
- 兼容两种响应模式
- 保留思考模式的推理能力

**缺点**：
- 增加维护复杂度
- 需要实现完整的 DSML 解析器

### 方案 C：条件性禁用思考（折中）

```typescript
const requestThinking = (request.toolChoice === "required" || 
                        typeof request.toolChoice === "object" ||
                        request.tools && request.tools.length > 0)  // 新增条件
  ? "disabled"
  : thinking;
```

**优点**：
- 有工具时禁用思考，保证工具调用可靠性
- 无工具时保留思考能力

## 时间线

- **2026-08-07 16:05:03**：最后一次发生 DSML 文本泄漏
- 用户发送"继续"后，对话继续（但第一次调用已失败）

## 影响范围

该问题影响所有使用 DeepSeek provider + 工具调用的场景，当满足以下条件时会触发：

1. `thinking: "enabled"` (默认配置)
2. `toolChoice: "auto"` (默认值)
3. 提供了 `tools` 数组
4. DeepSeek API 决定以文本模式生成工具调用而非结构化格式

## 建议措施

**短期**（推荐立即实施）：
- 修改 `deepseekProvider.ts`，工具调用时强制 `thinking: "disabled"`

**长期**（可选增强）：
- 实现 DSML 降级解析器作为兜底机制
- 监控 DeepSeek API 行为，确认是否为 API 层问题
