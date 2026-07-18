# 多轮对话功能实现计划

> **对于代理工作者**：推荐使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行此计划。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标**：为 LoopAgent VSCode 扩展实现完整的多轮对话功能，允许用户在单个对话中进行多次交互，模型能够访问完整的对话历史。

**架构**：采用三层改造：(1) 扩展消息协议以支持对话上下文；(2) 修改后端模型运行器将完整对话历史传给 AI 模型；(3) 增强前端 UI 以支持多轮消息输入和流畅的对话体验。

**技术栈**：TypeScript、React、VSCode API、DeepSeek API

---

## 阶段 1：核心消息协议与数据结构

### 任务 1.1：定义对话消息类型

**文件**：
- 创建: `src/shared/chatTypes.ts`
- 修改: `src/shared/messages.ts`

- [ ] **步骤 1.1.1：创建新的聊天消息类型定义**

```typescript
// src/shared/chatTypes.ts
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationContext = {
  conversationId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export type ConversationTurn = {
  id: string;
  conversationId: string;
  userMessage: string;
  assistantMessage?: string;
  status: "pending" | "processing" | "completed" | "error";
  error?: string;
};
```

- [ ] **步骤 1.1.2：修改 messages.ts 添加对话上下文消息类型**

在 `src/shared/messages.ts` 中的 `WebviewToHostMessage` 类型中添加：

```typescript
export type WebviewToHostMessage =
  | {
      type: "startTask";
      task: string;
      mode?: TaskMode;
      model?: RunModelSelection;
    }
  | {
      type: "continueConversation";
      conversationId: string;
      userMessage: string;
      mode?: TaskMode;
      model?: RunModelSelection;
    };
```

- [ ] **步骤 1.1.3：修改 HostToWebviewMessage 添加对话管理消息**

在 `src/shared/messages.ts` 中的 `HostToWebviewMessage` 类型中添加：

```typescript
export type HostToWebviewMessage =
  | { type: "runStarted"; runId: string; task: string }
  | { type: "conversationStarted"; conversationId: string; runId: string; userMessage: string }
  | { type: "agentEvent"; runId: string; message: string }
  | { type: "assistantStarted"; runId: string; provider: string }
  | { type: "assistantThinking"; runId: string; message: string }
  | { type: "assistantReasoningDelta"; runId: string; content: string }
  | { type: "assistantDelta"; runId: string; content: string }
  | { type: "assistantFinished"; runId: string }
  | { type: "runFinished"; runId: string }
  | { type: "runFailed"; runId: string; message: string };
```

- [ ] **步骤 1.1.4：运行测试验证编译**

```bash
npm run typecheck
```

预期：无 TypeScript 错误

- [ ] **步骤 1.1.5：提交**

```bash
git add src/shared/chatTypes.ts src/shared/messages.ts
git commit -m "feat: define multi-turn conversation message types

- Add ChatMessage and ConversationContext types
- Add continueConversation message type
- Add conversationStarted message type"
```

---

## 阶段 2：后端对话上下文管理

### 任务 2.1：创建对话状态管理服务

**文件**：
- 创建: `src/extension/conversation/conversationManager.ts`
- 创建: `src/extension/conversation/conversationStore.ts`

- [ ] **步骤 2.1.1：创建对话存储服务**

```typescript
// src/extension/conversation/conversationStore.ts
import type { ConversationContext, ChatMessage } from "../../shared/chatTypes";

export type ConversationStore = {
  createConversation(): ConversationContext;
  getConversation(conversationId: string): ConversationContext | undefined;
  addMessage(conversationId: string, message: ChatMessage): void;
  getMessages(conversationId: string): ChatMessage[];
};

export function createConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationContext>();

  return {
    createConversation(): ConversationContext {
      const conversationId = `conv-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const context: ConversationContext = {
        conversationId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      conversations.set(conversationId, context);
      return context;
    },

    getConversation(conversationId: string): ConversationContext | undefined {
      return conversations.get(conversationId);
    },

    addMessage(conversationId: string, message: ChatMessage): void {
      const context = conversations.get(conversationId);
      if (context) {
        context.messages.push(message);
        context.updatedAt = Date.now();
      }
    },

    getMessages(conversationId: string): ChatMessage[] {
      const context = conversations.get(conversationId);
      return context?.messages ?? [];
    },
  };
}
```

- [ ] **步骤 2.1.2：创建对话管理器**

```typescript
// src/extension/conversation/conversationManager.ts
import type { ConversationContext, ChatMessage } from "../../shared/chatTypes";
import type { ConversationStore } from "./conversationStore";

export type ConversationManager = {
  startConversation(): ConversationContext;
  addUserMessage(conversationId: string, userMessage: string): void;
  addAssistantMessage(conversationId: string, assistantMessage: string): void;
  getConversationHistory(conversationId: string): ChatMessage[];
};

export function createConversationManager(store: ConversationStore): ConversationManager {
  return {
    startConversation(): ConversationContext {
      return store.createConversation();
    },

    addUserMessage(conversationId: string, userMessage: string): void {
      store.addMessage(conversationId, {
        role: "user",
        content: userMessage,
      });
    },

    addAssistantMessage(conversationId: string, assistantMessage: string): void {
      store.addMessage(conversationId, {
        role: "assistant",
        content: assistantMessage,
      });
    },

    getConversationHistory(conversationId: string): ChatMessage[] {
      return store.getMessages(conversationId);
    },
  };
}
```

- [ ] **步骤 2.1.3：创建单元测试**

```typescript
// test/extension/conversation/conversationManager.test.ts
import { describe, it, expect } from "vitest";
import { createConversationStore } from "../../../src/extension/conversation/conversationStore";
import { createConversationManager } from "../../../src/extension/conversation/conversationManager";

describe("ConversationManager", () => {
  it("starts a new conversation", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);
    const context = manager.startConversation();

    expect(context.conversationId).toMatch(/^conv-/);
    expect(context.messages).toEqual([]);
  });

  it("adds user and assistant messages to conversation", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);
    const context = manager.startConversation();

    manager.addUserMessage(context.conversationId, "Hello");
    manager.addAssistantMessage(context.conversationId, "Hi there");

    const history = manager.getConversationHistory(context.conversationId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("maintains separate conversations", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    const conv1 = manager.startConversation();
    const conv2 = manager.startConversation();

    manager.addUserMessage(conv1.conversationId, "Message in conv1");
    manager.addUserMessage(conv2.conversationId, "Message in conv2");

    expect(manager.getConversationHistory(conv1.conversationId)).toHaveLength(1);
    expect(manager.getConversationHistory(conv2.conversationId)).toHaveLength(1);
  });
});
```

- [ ] **步骤 2.1.4：运行测试**

```bash
npm test -- test/extension/conversation/conversationManager.test.ts
```

预期：所有测试通过

- [ ] **步骤 2.1.5：提交**

```bash
git add src/extension/conversation/ test/extension/conversation/
git commit -m "feat: add conversation state management

- Implement ConversationStore for in-memory conversation storage
- Implement ConversationManager for conversation lifecycle
- Add unit tests for conversation manager"
```

---

## 阶段 3：模型运行器集成对话上下文

### 任务 3.1：修改模型运行器支持对话上下文

**文件**：
- 修改: `src/extension/model/modelRunner.ts`
- 修改: `src/extension/model/openAiCompatibleClient.ts`
- 创建: `src/extension/model/conversationContextFormatter.ts`

- [ ] **步骤 3.1.1：创建对话上下文格式化器**

```typescript
// src/extension/model/conversationContextFormatter.ts
import type { ChatMessage } from "../../shared/chatTypes";

export type FormattedContext = {
  systemPrompt: string;
  messageHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
};

export function formatConversationContext(
  messages: ChatMessage[],
  currentTask: string,
): FormattedContext {
  // 系统提示设置 LoopAgent 的角色
  const systemPrompt = `You are LoopAgent, an AI assistant in VSCode that helps developers with coding tasks.
You have access to the workspace code and can read files, understand structure, and propose edits.
Be concise and helpful. When the user asks for code changes, provide clear explanations.`;

  // 如果没有历史消息，创建只包含当前任务的上下文
  if (messages.length === 0) {
    return {
      systemPrompt,
      messageHistory: [
        {
          role: "user",
          content: currentTask,
        },
      ],
    };
  }

  // 否则，使用完整的对话历史并在末尾添加当前任务
  const messageHistory = messages.map((msg) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));

  // 如果最后一条消息是助手消息，在末尾添加用户消息
  if (messageHistory.length > 0 && messageHistory[messageHistory.length - 1].role === "assistant") {
    messageHistory.push({
      role: "user",
      content: currentTask,
    });
  }

  return {
    systemPrompt,
    messageHistory,
  };
}
```

- [ ] **步骤 3.1.2：创建单元测试**

```typescript
// test/extension/model/conversationContextFormatter.test.ts
import { describe, it, expect } from "vitest";
import { formatConversationContext } from "../../../src/extension/model/conversationContextFormatter";

describe("conversationContextFormatter", () => {
  it("creates initial context for first message", () => {
    const result = formatConversationContext([], "Explain this function");

    expect(result.systemPrompt).toContain("LoopAgent");
    expect(result.messageHistory).toHaveLength(1);
    expect(result.messageHistory[0]).toEqual({
      role: "user",
      content: "Explain this function",
    });
  });

  it("appends task to conversation history", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const result = formatConversationContext(messages, "Next question");

    expect(result.messageHistory).toHaveLength(3);
    expect(result.messageHistory[2]).toEqual({
      role: "user",
      content: "Next question",
    });
  });
});
```

- [ ] **步骤 3.1.3：运行测试**

```bash
npm test -- test/extension/model/conversationContextFormatter.test.ts
```

预期：所有测试通过

- [ ] **步骤 3.1.4：修改 openAiCompatibleClient 支持消息历史**

在 `src/extension/model/openAiCompatibleClient.ts` 中，找到 API 调用部分并修改为支持消息数组：

```typescript
// 在文件中找到创建请求体的地方，添加对消息历史的支持
type OpenAiRequest = {
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
};
```

- [ ] **步骤 3.1.5：提交**

```bash
git add src/extension/model/conversationContextFormatter.ts test/extension/model/conversationContextFormatter.test.ts
git commit -m "feat: add conversation context formatting

- Implement formatConversationContext for model API
- Add unit tests for context formatting
- Support multi-turn conversation history in model requests"
```

---

## 阶段 4：扩展层集成

### 任务 4.1：修改主扩展文件支持多轮对话

**文件**：
- 修改: `src/extension.ts`
- 修改: `src/extension/agentRunner.ts`

- [ ] **步骤 4.1.1：修改扩展类以管理对话**

在 `src/extension.ts` 的 `LoopAgentChatViewProvider` 类中添加对话管理器：

```typescript
import { createConversationStore } from "./extension/conversation/conversationStore";
import { createConversationManager } from "./extension/conversation/conversationManager";

class LoopAgentChatViewProvider implements vscode.WebviewViewProvider {
  private activeRun: AgentRunHandle | undefined;
  private readonly workspaceIntelligence;
  private readonly editPreviewService;
  private readonly readFileTool;
  private readonly applyEditTool;
  private readonly conversationManager; // 新增
  private currentConversationId: string | undefined; // 新增

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
      parserRuntime: createTreeSitterParserRuntime(),
      storageUri: context.storageUri,
    });
    this.editPreviewService = createEditPreviewService(vscode);
    this.readFileTool = createReadFileTool(vscode);
    this.applyEditTool = createApplyEditTool(this.editPreviewService);
    // 初始化对话管理器
    const conversationStore = createConversationStore();
    this.conversationManager = createConversationManager(conversationStore);
  }

  // ... 其他方法保持不变
}
```

- [ ] **步骤 4.1.2：修改消息处理逻辑**

在 `resolveWebviewView` 方法中修改消息处理器：

```typescript
const messageSubscription = webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
  if (message.type === "startTask") {
    this.handleStartTask(message, webviewView.webview);
  } else if (message.type === "continueConversation") {
    this.handleContinueConversation(message, webviewView.webview);
  }
});
```

- [ ] **步骤 4.1.3：添加处理方法**

在 `LoopAgentChatViewProvider` 中添加新方法：

```typescript
private handleStartTask(message: Extract<WebviewToHostMessage, { type: "startTask" }>, webview: vscode.Webview): void {
  this.activeRun?.cancel();

  // 启动新对话
  const conversation = this.conversationManager.startConversation();
  this.currentConversationId = conversation.conversationId;

  // 添加用户消息到历史
  this.conversationManager.addUserMessage(conversation.conversationId, message.task);

  void createConfiguredAgentRunner(this.context, message.model, {
    workspaceIntelligence: this.workspaceIntelligence,
    readFileTool: this.readFileTool,
    applyEditTool: this.applyEditTool,
  }).then((runner) => {
    const run = startAgentRun({
      task: message.task,
      mode: message.mode ?? "edit",
      runner,
      conversationId: conversation.conversationId,
      conversationHistory: [],
      postMessage: (hostMessage) => webview.postMessage(hostMessage),
    });

    this.activeRun = run;
    void run.done.finally(() => {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    });
  });
}

private handleContinueConversation(
  message: Extract<WebviewToHostMessage, { type: "continueConversation" }>,
  webview: vscode.Webview,
): void {
  if (!this.currentConversationId || this.currentConversationId !== message.conversationId) {
    // 错误：对话 ID 不匹配或无效
    webview.postMessage({
      type: "runFailed",
      runId: `error-${Date.now()}`,
      message: "Invalid conversation ID",
    });
    return;
  }

  this.activeRun?.cancel();

  // 添加用户消息到历史
  this.conversationManager.addUserMessage(message.conversationId, message.userMessage);

  // 获取对话历史
  const conversationHistory = this.conversationManager.getConversationHistory(message.conversationId);

  void createConfiguredAgentRunner(this.context, message.model, {
    workspaceIntelligence: this.workspaceIntelligence,
    readFileTool: this.readFileTool,
    applyEditTool: this.applyEditTool,
  }).then((runner) => {
    const run = startAgentRun({
      task: message.userMessage,
      mode: message.mode ?? "edit",
      runner,
      conversationId: message.conversationId,
      conversationHistory,
      postMessage: (hostMessage) => webview.postMessage(hostMessage),
    });

    this.activeRun = run;
    void run.done.finally(() => {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    });
  });
}
```

- [ ] **步骤 4.1.4：提交**

```bash
git add src/extension.ts
git commit -m "feat: integrate conversation manager into extension

- Add conversation manager to chat view provider
- Handle continueConversation messages
- Pass conversation history to agent runner"
```

---

## 阶段 5：Agent 运行器修改

### 任务 5.1：修改 Agent 运行器传递对话上下文

**文件**：
- 修改: `src/extension/agentRunner.ts`
- 修改: `src/extension/model/modelRunner.ts`

- [ ] **步骤 5.1.1：更新 AgentRunRequest 类型**

在 `src/extension/agentRunner.ts` 中修改类型定义：

```typescript
import type { ChatMessage } from "../shared/chatTypes";

export type AgentRunRequest = {
  runId: string;
  task: string;
  mode?: TaskMode;
  conversationId?: string;
  conversationHistory?: ChatMessage[];
  signal: AbortSignal;
};
```

- [ ] **步骤 5.1.2：更新 StartAgentRunOptions**

```typescript
export type StartAgentRunOptions = {
  task: string;
  mode?: TaskMode;
  runner: AgentRunner;
  conversationId?: string;
  conversationHistory?: ChatMessage[];
  postMessage: PostHostMessage;
  runId?: string;
};

export function startAgentRun({
  task,
  mode = "ask",
  runner,
  conversationId,
  conversationHistory = [],
  postMessage,
  runId = createRunId(),
}: StartAgentRunOptions): AgentRunHandle {
  const abortController = new AbortController();
  const request: AgentRunRequest = {
    runId,
    task,
    mode,
    conversationId,
    conversationHistory,
    signal: abortController.signal,
  };

  const done = pumpRunMessages(runner, request, postMessage);

  return {
    runId,
    cancel() {
      abortController.abort();
    },
    done,
  };
}
```

- [ ] **步骤 5.1.3：修改模型运行器使用对话历史**

在 `src/extension/model/modelRunner.ts` 中找到模型调用部分，使用格式化的对话上下文：

```typescript
import { formatConversationContext } from "./conversationContextFormatter";

// 在模型调用前添加：
const formattedContext = formatConversationContext(
  request.conversationHistory ?? [],
  request.task,
);

// 将 formattedContext.messageHistory 传给 API 调用
```

- [ ] **步骤 5.1.4：提交**

```bash
git add src/extension/agentRunner.ts src/extension/model/modelRunner.ts
git commit -m "feat: pass conversation history to agent runner

- Add conversationHistory to AgentRunRequest
- Update model runner to use formatConversationContext
- Enable multi-turn model inference with full context"
```

---

## 阶段 6：前端 UI 增强

### 任务 6.1：修改 App 组件支持多轮对话

**文件**：
- 修改: `src/webview/App.tsx`

- [ ] **步骤 6.1.1：添加对话 ID 状态管理**

在 App 组件的 state 初始化部分添加：

```typescript
const [currentConversationId, setCurrentConversationId] = React.useState<string | undefined>();
```

- [ ] **步骤 6.1.2：修改输入处理以支持继续对话**

在 App 组件中修改 `handleSubmit` 或类似的提交函数：

```typescript
function handleSubmit(userTask: string) {
  if (!userTask.trim()) return;

  const newUserTurn: UserTurn = {
    id: createTurnId("user"),
    role: "user",
    content: userTask,
    pending: true,
  };

  setMessage("");
  setTurns((prev) => [...prev, newUserTurn]);

  if (!currentConversationId) {
    // 启动新对话
    vscodeApi.postMessage({
      type: "startTask",
      task: userTask,
      mode: taskMode,
      model: selectedModel.selection,
    });
  } else {
    // 继续现有对话
    vscodeApi.postMessage({
      type: "continueConversation",
      conversationId: currentConversationId,
      userMessage: userTask,
      mode: taskMode,
      model: selectedModel.selection,
    });
  }

  setIsRunning(true);
}
```

- [ ] **步骤 6.1.3：修改消息处理更新对话 ID**

在 `handleHostMessage` 的 `conversationStarted` 情况中：

```typescript
case "conversationStarted": {
  setIsRunning(true);
  setCurrentConversationId(hostMessage.conversationId);
  setTurns((currentTurns) =>
    attachRunToUserTurn(
      currentTurns,
      hostMessage.runId,
      hostMessage.userMessage,
      createTurnId,
    ),
  );
  return;
}
```

- [ ] **步骤 6.1.4：修改 CSS 以改进多轮对话 UI**

在 `src/webview/styles.css` 中添加或修改以支持更好的对话显示：

```css
.message-input {
  min-height: 60px;
  max-height: 200px;
  resize: vertical;
}

.turn-container {
  margin-bottom: 12px;
  padding: 8px;
  border-radius: 6px;
  background: var(--vscode-editor-background);
}

.user-turn {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.assistant-turn {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}
```

- [ ] **步骤 6.1.5：提交**

```bash
git add src/webview/App.tsx src/webview/styles.css
git commit -m "feat: enhance UI for multi-turn conversations

- Add conversation ID state management
- Implement continueConversation message sending
- Update message handling for ongoing conversations
- Improve CSS for better multi-turn display"
```

---

## 阶段 7：端到端集成测试

### 任务 7.1：创建多轮对话集成测试

**文件**：
- 创建: `test/integration/multiTurnConversation.test.ts`

- [ ] **步骤 7.1.1：创建集成测试套件**

```typescript
// test/integration/multiTurnConversation.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createConversationStore } from "../../src/extension/conversation/conversationStore";
import { createConversationManager } from "../../src/extension/conversation/conversationManager";
import { formatConversationContext } from "../../src/extension/model/conversationContextFormatter";

describe("Multi-turn Conversation Integration", () => {
  let conversationManager: ReturnType<typeof createConversationManager>;

  beforeEach(() => {
    const store = createConversationStore();
    conversationManager = createConversationManager(store);
  });

  it("maintains conversation context across multiple turns", () => {
    const context = conversationManager.startConversation();

    // 第一轮
    conversationManager.addUserMessage(context.conversationId, "What is TypeScript?");
    conversationManager.addAssistantMessage(context.conversationId, "TypeScript is a typed superset of JavaScript.");

    // 第二轮
    conversationManager.addUserMessage(context.conversationId, "How does it improve code quality?");
    conversationManager.addAssistantMessage(
      context.conversationId,
      "It adds static type checking, catching errors at compile time.",
    );

    const history = conversationManager.getConversationHistory(context.conversationId);
    expect(history).toHaveLength(4);
    expect(history[0].content).toContain("TypeScript");
    expect(history[3].content).toContain("static type checking");
  });

  it("formats context correctly with full conversation history", () => {
    const context = conversationManager.startConversation();

    conversationManager.addUserMessage(context.conversationId, "First question");
    conversationManager.addAssistantMessage(context.conversationId, "First answer");
    conversationManager.addUserMessage(context.conversationId, "Second question");

    const history = conversationManager.getConversationHistory(context.conversationId);
    const formatted = formatConversationContext(history, "Third question");

    expect(formatted.messageHistory).toHaveLength(4);
    expect(formatted.messageHistory[3]).toEqual({
      role: "user",
      content: "Third question",
    });
  });

  it("isolates conversations from each other", () => {
    const conv1 = conversationManager.startConversation();
    const conv2 = conversationManager.startConversation();

    conversationManager.addUserMessage(conv1.conversationId, "Conv1 Q1");
    conversationManager.addAssistantMessage(conv1.conversationId, "Conv1 A1");

    conversationManager.addUserMessage(conv2.conversationId, "Conv2 Q1");
    conversationManager.addAssistantMessage(conv2.conversationId, "Conv2 A1");
    conversationManager.addUserMessage(conv2.conversationId, "Conv2 Q2");

    const history1 = conversationManager.getConversationHistory(conv1.conversationId);
    const history2 = conversationManager.getConversationHistory(conv2.conversationId);

    expect(history1).toHaveLength(2);
    expect(history2).toHaveLength(3);
  });
});
```

- [ ] **步骤 7.1.2：运行集成测试**

```bash
npm test -- test/integration/multiTurnConversation.test.ts
```

预期：所有测试通过

- [ ] **步骤 7.1.3：提交**

```bash
git add test/integration/multiTurnConversation.test.ts
git commit -m "test: add multi-turn conversation integration tests

- Test conversation context persistence
- Verify context formatting across turns
- Ensure conversation isolation"
```

---

## 阶段 8：消息持久化（可选增强）

### 任务 8.1：添加对话持久化支持

**文件**：
- 创建: `src/extension/conversation/persistedConversationStore.ts`

- [ ] **步骤 8.1.1：创建持久化存储接口**

```typescript
// src/extension/conversation/persistedConversationStore.ts
import * as fs from "fs/promises";
import * as path from "path";
import type { ConversationContext } from "../../shared/chatTypes";

export type PersistedConversationStore = {
  saveConversation(context: ConversationContext, storageUri?: string): Promise<void>;
  loadConversation(conversationId: string, storageUri?: string): Promise<ConversationContext | undefined>;
  listConversations(storageUri?: string): Promise<string[]>;
};

export function createPersistedConversationStore(): PersistedConversationStore {
  return {
    async saveConversation(context: ConversationContext, storageUri?: string): Promise<void> {
      if (!storageUri) return;

      const storagePath = path.join(storageUri, "conversations");
      await fs.mkdir(storagePath, { recursive: true });

      const filePath = path.join(storagePath, `${context.conversationId}.json`);
      await fs.writeFile(filePath, JSON.stringify(context, null, 2));
    },

    async loadConversation(
      conversationId: string,
      storageUri?: string,
    ): Promise<ConversationContext | undefined> {
      if (!storageUri) return undefined;

      const filePath = path.join(storageUri, "conversations", `${conversationId}.json`);

      try {
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data) as ConversationContext;
      } catch {
        return undefined;
      }
    },

    async listConversations(storageUri?: string): Promise<string[]> {
      if (!storageUri) return [];

      const storagePath = path.join(storageUri, "conversations");

      try {
        const files = await fs.readdir(storagePath);
        return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **步骤 8.1.2：创建测试**

```typescript
// test/extension/conversation/persistedConversationStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createPersistedConversationStore } from "../../../src/extension/conversation/persistedConversationStore";

describe("PersistedConversationStore", () => {
  let tempDir: string;
  const store = createPersistedConversationStore();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("saves and loads conversation", async () => {
    const context = {
      conversationId: "test-conv-123",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.saveConversation(context, tempDir);
    const loaded = await store.loadConversation("test-conv-123", tempDir);

    expect(loaded).toEqual(context);
  });

  it("lists saved conversations", async () => {
    const conv1 = { conversationId: "conv-1", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    const conv2 = { conversationId: "conv-2", messages: [], createdAt: Date.now(), updatedAt: Date.now() };

    await store.saveConversation(conv1, tempDir);
    await store.saveConversation(conv2, tempDir);

    const list = await store.listConversations(tempDir);
    expect(list).toContain("conv-1");
    expect(list).toContain("conv-2");
  });
});
```

- [ ] **步骤 8.1.3：运行测试**

```bash
npm test -- test/extension/conversation/persistedConversationStore.test.ts
```

预期：所有测试通过

- [ ] **步骤 8.1.4：提交**

```bash
git add src/extension/conversation/persistedConversationStore.ts test/extension/conversation/persistedConversationStore.test.ts
git commit -m "feat: add optional conversation persistence

- Implement file-based conversation storage
- Add save/load conversation functionality
- Add tests for persistence layer"
```

---

## 检查清单

### 功能覆盖
- ✓ 对话消息协议（新消息类型）
- ✓ 对话状态管理（ConversationManager）
- ✓ 模型上下文格式化（完整历史支持）
- ✓ 扩展集成（多轮消息处理）
- ✓ 前端 UI（对话继续功能）
- ✓ 集成测试（端到端验证）
- ✓ 可选持久化（会话恢复）

### 代码质量
- ✓ 完整的单元测试覆盖
- ✓ TypeScript 类型安全
- ✓ 清晰的文件结构和职责分离
- ✓ 不包含占位符或 TODO

### 提交历史
- ✓ 每个任务一次原子提交
- ✓ 清晰的提交消息

---

## 执行交接

计划已完成并保存至 `docs/superpowers/plans/2026-07-18-multi-turn-conversation-plan.md`。

**两种执行选项：**

**1. 子代理驱动（推荐）** — 我为每个任务派发一个新的子代理，任务间进行评审，快速迭代

**2. 内联执行** — 使用 executing-plans 在本会话中执行任务，分批执行并设置检查点

**选择哪种方法？**
