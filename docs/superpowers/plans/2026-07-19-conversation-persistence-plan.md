# 多轮对话持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前进程内存里的活跃对话持久化到工作区本地 `.loopagent/conversation.sqlite`，重开面板/重启 VS Code 后自动恢复，并加一个"新对话"入口清空当前对话。

**Architecture:** `ConversationStore` 接口新增 `loadActiveConversation()`/`clearActiveConversation()`，内存实现（`conversationStore.ts`）和新的 SQLite 实现（`persistentConversationStore.ts`）都要满足这个接口；`extension.ts` 根据有没有工作区文件夹二选一。恢复流程走一次 webview→host 的 `webviewReady` 握手，避免 host 在 webview 消息监听器挂载前就把 `conversationRestored` 发丢了。

**Tech Stack:** `node:sqlite`（`DatabaseSync`，项目已用于代码索引，无新依赖）、Vitest、React Testing Library。

**依据设计文档：** `docs/superpowers/specs/2026-07-19-conversation-persistence-design.md`

---

## 设计澄清（相对 spec 的补充细节）

写这份计划时发现 spec 没覆盖的一个真实的时序问题，这里一并定下来，不是范围扩大：

- **`webviewReady` 握手**：`resolveWebviewView()` 设置完 `webview.html` 后如果立刻 `postMessage` 恢复消息，webview 侧 React 组件的 `window.addEventListener("message", ...)` 大概率还没挂载（脚本还在加载/执行），消息会丢。加一个最小握手：webview 挂载后先 `postMessage({ type: "webviewReady" })`，host 收到后再发 `conversationRestored`。
- **"新对话"时取消正在跑的 run**：如果点"新对话"时有请求正在流式返回，`turns` 被清空后，旧 `runId` 的后续 `assistantDelta` 会在清空后的数组里重新长出一条"幽灵消息"。`handleNewConversation`（host 侧）里顺带 `this.activeRun?.cancel()`，跟现有 `webviewView.onDidDispose` 里的取消逻辑保持一致，问题不存在了。

---

### Task 1: `ConversationStore` 接口加恢复/清空能力

**Files:**
- Modify: `src/extension/conversation/conversationStore.ts:7-39`（接口）、`:65-94`（内存实现）
- Test: `test/extension/conversation/conversationStore.test.ts`（新建）

- [ ] **Step 1: 写失败的测试**

创建 `test/extension/conversation/conversationStore.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { createConversationStore } from "../../../src/extension/conversation/conversationStore";

describe("createConversationStore (in-memory fallback)", () => {
  it("has nothing to restore on a fresh store", () => {
    const store = createConversationStore();
    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("clearActiveConversation is a safe no-op and does not touch existing conversations", () => {
    const store = createConversationStore();
    const context = store.createConversation();

    store.clearActiveConversation();

    // 内存实现本来就没有"单活跃对话"的概念（一直支持多个并存的对话，
    // 见 test/extension/multiTurnConversation.integration.test.ts 的
    // "maintains separate conversations independently"），clearActiveConversation
    // 在这里只是满足接口，不做任何删除。
    expect(store.getConversation(context.conversationId)).toEqual(context);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- conversationStore.test.ts`
Expected: FAIL — `store.loadActiveConversation is not a function`

- [ ] **Step 3: 实现**

编辑 `src/extension/conversation/conversationStore.ts`，接口（第 7-39 行）里加两个方法：

```typescript
export type ConversationStore = {
  createConversation(): ConversationContext;
  getConversation(conversationId: string): ConversationContext | undefined;
  addMessage(conversationId: string, message: ChatMessage): void;
  getMessages(conversationId: string): ChatMessage[];

  /**
   * 加载持久化实现里保存的"上一次未结束的对话"。
   * 内存实现没有跨进程状态，永远返回 undefined。
   */
  loadActiveConversation(): ConversationContext | undefined;

  /**
   * 清空"当前活跃对话"，供"新对话"入口调用。
   * 内存实现没有单活跃对话的概念，是安全的空操作。
   */
  clearActiveConversation(): void;
};
```

`createConversationStore()` 返回对象（第 65-94 行）里加实现，紧跟在 `getMessages` 后面：

```typescript
    getMessages(conversationId: string): ChatMessage[] {
      const context = conversations.get(conversationId);
      return context?.messages ?? [];
    },

    loadActiveConversation(): ConversationContext | undefined {
      return undefined;
    },

    clearActiveConversation(): void {
      // no-op：内存实现没有持久化的"活跃对话"可清
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- conversationStore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 提交**

```bash
git add src/extension/conversation/conversationStore.ts test/extension/conversation/conversationStore.test.ts
git commit -m "feat(conversation): add loadActiveConversation/clearActiveConversation to ConversationStore"
```

---

### Task 2: `ConversationManager` 透传新方法

**Files:**
- Modify: `src/extension/conversation/conversationManager.ts:8-42`（接口）、`:54-79`（实现）
- Test: `test/extension/conversation/conversationManager.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `test/extension/conversation/conversationManager.test.ts` 末尾（`describe` 块内）加：

```typescript
  it("delegates loadActiveConversation and clearActiveConversation to the store", () => {
    const store = createConversationStore();
    const manager = createConversationManager(store);

    expect(manager.loadActiveConversation()).toBeUndefined();

    manager.startConversation();
    expect(() => manager.clearActiveConversation()).not.toThrow();
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- conversationManager.test.ts`
Expected: FAIL — `manager.loadActiveConversation is not a function`

- [ ] **Step 3: 实现**

编辑 `src/extension/conversation/conversationManager.ts`，接口（第 8-42 行）加：

```typescript
export type ConversationManager = {
  startConversation(): ConversationContext;
  addUserMessage(conversationId: string, userMessage: string): void;
  addAssistantMessage(conversationId: string, assistantMessage: string, reasoning?: string): void;
  getConversationHistory(conversationId: string): ChatMessage[];

  /** 透传 ConversationStore.loadActiveConversation */
  loadActiveConversation(): ConversationContext | undefined;

  /** 透传 ConversationStore.clearActiveConversation */
  clearActiveConversation(): void;
};
```

`createConversationManager` 返回对象（第 54-79 行）里加：

```typescript
    getConversationHistory(conversationId: string): ChatMessage[] {
      return store.getMessages(conversationId);
    },

    loadActiveConversation(): ConversationContext | undefined {
      return store.loadActiveConversation();
    },

    clearActiveConversation(): void {
      store.clearActiveConversation();
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- conversationManager.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/extension/conversation/conversationManager.ts test/extension/conversation/conversationManager.test.ts
git commit -m "feat(conversation): delegate restore/clear methods through ConversationManager"
```

---

### Task 3: 消息协议加三个新成员

**Files:**
- Modify: `src/shared/messages.ts:20-33`（`WebviewToHostMessage`）、`:35-94`（`HostToWebviewMessage`）

这一步纯类型改动，没有独立测试文件——下一步 `npm run typecheck` 会因为 `App.tsx` 的穷尽性检查（`const _exhaustive: never = hostMessage;`，`src/webview/App.tsx:227`）而报错，这正是我们要的"先跑失败"信号，Task 6 会消掉它。

- [ ] **Step 1: 编辑 `src/shared/messages.ts`**

`WebviewToHostMessage`（第 20-33 行）加两个成员：

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
    }
  | {
      /** Webview 挂载完成，可以安全接收恢复消息了 */
      type: "webviewReady";
    }
  | {
      /** 用户点击"新对话"，清空当前活跃对话 */
      type: "newConversation";
    };
```

`HostToWebviewMessage`（第 35-94 行）末尾（`conversationStarted` 成员后）加一个成员：

```typescript
  | {
      /** Conversation start: signals beginning of a conversation turn */
      type: "conversationStarted";
      conversationId: string;
      runId: string;
      userMessage: string;
    }
  | {
      /** 收到 webviewReady 后，把上一次未结束的对话推给 webview */
      type: "conversationRestored";
      conversationId: string;
      messages: ChatMessage[];
    };
```

文件顶部需要引入 `ChatMessage` 类型：

```typescript
import type { ChatMessage } from "./chatTypes";
```

- [ ] **Step 2: 运行 typecheck，确认按预期报错**

Run: `npm run typecheck`
Expected: FAIL — `src/webview/App.tsx:227:11 - error TS2322: Type '"webviewReady" | "newConversation"' is not assignable to type 'never'.`（或类似的穷尽性检查报错；具体消息以实际输出为准，重点是编译不过）

- [ ] **Step 3: 提交**

这一步先提交类型改动本身。仓库没有跑 typecheck 的 pre-commit hook（`.husky/` 下没有 pre-commit 脚本），所以即使全量 `npm run typecheck` 此刻会失败（预期的中间状态，Task 6 会修好），也不会拦下这次提交：

```bash
git add src/shared/messages.ts
git commit -m "feat(messages): add webviewReady/newConversation/conversationRestored message types"
```

---

### Task 4: `persistentConversationStore.ts`（SQLite 实现）

**Files:**
- Create: `src/extension/conversation/persistentConversationStore.ts`
- Test: `test/extension/conversation/persistentConversationStore.test.ts`（新建）

- [ ] **Step 1: 写失败的测试**

创建 `test/extension/conversation/persistentConversationStore.test.ts`：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPersistentConversationStore } from "../../../src/extension/conversation/persistentConversationStore";

const directories: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openTempStore() {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
  directories.push(directory);
  const databasePath = join(directory, "conversation.sqlite");
  const store = createPersistentConversationStore(databasePath);
  openStores.push(store);
  return { store, databasePath };
}

describe("createPersistentConversationStore", () => {
  it("has nothing to restore on a fresh database", () => {
    const { store } = openTempStore();
    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("persists messages and reloads them after reopening the database", () => {
    const { store, databasePath } = openTempStore();
    const context = store.createConversation();
    store.addMessage(context.conversationId, { role: "user", content: "Hello" });
    store.addMessage(context.conversationId, { role: "assistant", content: "Hi there" });

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    const restored = reopened.loadActiveConversation();

    expect(restored?.conversationId).toBe(context.conversationId);
    expect(restored?.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("keeps only one active conversation: starting a new one replaces the old row", () => {
    const { store, databasePath } = openTempStore();
    const first = store.createConversation();
    store.addMessage(first.conversationId, { role: "user", content: "First" });

    const second = store.createConversation();
    store.addMessage(second.conversationId, { role: "user", content: "Second" });

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    const restored = reopened.loadActiveConversation();

    expect(restored?.conversationId).toBe(second.conversationId);
    expect(restored?.messages).toEqual([{ role: "user", content: "Second" }]);
  });

  it("clearActiveConversation deletes the persisted row", () => {
    const { store, databasePath } = openTempStore();
    const context = store.createConversation();
    store.addMessage(context.conversationId, { role: "user", content: "Hello" });

    store.clearActiveConversation();
    expect(store.loadActiveConversation()).toBeUndefined();

    const reopened = createPersistentConversationStore(databasePath);
    openStores.push(reopened);
    expect(reopened.loadActiveConversation()).toBeUndefined();
  });

  it("ignores addMessage for an unknown conversationId, matching the in-memory store", () => {
    const { store } = openTempStore();
    store.addMessage("nonexistent", { role: "user", content: "orphan" });
    expect(store.loadActiveConversation()).toBeUndefined();
  });

  it("creates the parent directory if it does not exist yet", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-conversation-"));
    directories.push(directory);
    const databasePath = join(directory, "nested", ".loopagent", "conversation.sqlite");

    const store = createPersistentConversationStore(databasePath);
    openStores.push(store);

    expect(store.loadActiveConversation()).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- persistentConversationStore.test.ts`
Expected: FAIL — 找不到模块 `src/extension/conversation/persistentConversationStore`

- [ ] **Step 3: 实现**

创建 `src/extension/conversation/persistentConversationStore.ts`：

```typescript
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ChatMessage, ConversationContext } from "../../shared/chatTypes";
import type { ConversationStore } from "./conversationStore";

type ConversationRow = {
  conversation_id: string;
  messages_json: string;
  created_at: number;
  updated_at: number;
};

/**
 * ConversationStore 的 SQLite 持久化实现。
 * 表里最多一行，代表"当前活跃对话"——见
 * docs/superpowers/specs/2026-07-19-conversation-persistence-design.md
 * 的"单行表，不做消息级关系表"。
 */
export function createPersistentConversationStore(
  databasePath: string,
): ConversationStore & { close(): void } {
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
  );
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation (
      conversation_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  let active: ConversationContext | undefined = loadFromDatabase();

  function loadFromDatabase(): ConversationContext | undefined {
    const row = database
      .prepare("SELECT conversation_id, messages_json, created_at, updated_at FROM conversation LIMIT 1")
      .get() as ConversationRow | undefined;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      messages: JSON.parse(row.messages_json) as ChatMessage[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function persist(context: ConversationContext): void {
    database.exec("DELETE FROM conversation");
    database
      .prepare(
        "INSERT INTO conversation (conversation_id, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(context.conversationId, JSON.stringify(context.messages), context.createdAt, context.updatedAt);
  }

  return {
    createConversation(): ConversationContext {
      const context: ConversationContext = {
        conversationId: generateConversationId(),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      active = context;
      persist(context);
      return context;
    },

    getConversation(conversationId: string): ConversationContext | undefined {
      return active?.conversationId === conversationId ? active : undefined;
    },

    addMessage(conversationId: string, message: ChatMessage): void {
      if (active?.conversationId !== conversationId) return;
      active.messages.push(message);
      active.updatedAt = Date.now();
      persist(active);
    },

    getMessages(conversationId: string): ChatMessage[] {
      return active?.conversationId === conversationId ? active.messages : [];
    },

    loadActiveConversation(): ConversationContext | undefined {
      return active;
    },

    clearActiveConversation(): void {
      active = undefined;
      database.exec("DELETE FROM conversation");
    },

    close(): void {
      database.close();
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- persistentConversationStore.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/extension/conversation/persistentConversationStore.ts test/extension/conversation/persistentConversationStore.test.ts
git commit -m "feat(conversation): add SQLite-backed persistent conversation store"
```

---

### Task 5: `extension.ts` 接线

**Files:**
- Modify: `src/extension.ts:1-16`（imports）、`:63-87`（类字段与构造函数）、`:89-122`（`resolveWebviewView`）

这一步没有自动化测试——`LoopAgentChatViewProvider` 依赖真实 `vscode` 模块，仓库里现有的测试（`multiTurnConversation.integration.test.ts` 等）从来没有实例化过它，也没有 fake vscode API 的测试夹具（跟 `vscodeWorkspaceIntelligence.ts` 不一样，那个类专门抽了 `VsCodeWorkspaceApi` 接口才能测）。这次不新增这类夹具（超出本次范围），靠 `npm run typecheck` + `npm run compile` 验证编译正确，靠 `/run` 技能在真实 Extension Development Host 里手动跑一遍验证行为。

- [ ] **Step 1: 编辑 imports（第 1-16 行）**

```typescript
import * as vscode from "vscode";
import { join } from "node:path";

import { createApplyEditTool } from "./extension/agent/applyEditTool";
import { createEditPreviewService } from "./extension/agent/editPreviewService";
import { createReadFileTool } from "./extension/agent/readFileTool";
import { startAgentRun, type AgentRunHandle } from "./extension/agentRunner";
import { createTreeSitterParserRuntime } from "./extension/intelligence/parser/treeSitterRuntime";
import { createVsCodeWorkspaceIntelligence } from "./extension/intelligence/vscodeWorkspaceIntelligence";
import { clearModelApiKey, getConfiguredProviderId, setModelApiKey } from "./extension/model/modelConfig";
import { createConfiguredAgentRunner } from "./extension/model/providerRegistry";
import { createWebviewHtml } from "./extension/webviewHtml";
import { createConversationStore } from "./extension/conversation/conversationStore";
import { createPersistentConversationStore } from "./extension/conversation/persistentConversationStore";
import { createConversationManager, type ConversationManager } from "./extension/conversation/conversationManager";
import type { ConversationStore } from "./extension/conversation/conversationStore";
import type { WebviewToHostMessage, HostToWebviewMessage } from "./shared/messages";
import type { ChatMessage } from "./shared/chatTypes";
```

- [ ] **Step 2: 类字段与构造函数（第 63-87 行）**

```typescript
class LoopAgentChatViewProvider implements vscode.WebviewViewProvider {
  private activeRun: AgentRunHandle | undefined;
  private readonly workspaceIntelligence;
  private readonly editPreviewService;
  private readonly readFileTool;
  private readonly applyEditTool;
  private readonly conversationStore: ConversationStore & { close?(): void };
  private readonly conversationManager: ConversationManager;
  private currentConversationId: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
      parserRuntime: createTreeSitterParserRuntime(),
      storageUri: context.storageUri,
    });
    this.editPreviewService = createEditPreviewService(vscode);
    this.readFileTool = createReadFileTool(vscode);
    this.applyEditTool = createApplyEditTool(this.editPreviewService);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.conversationStore = workspaceRoot
      ? createPersistentConversationStore(join(workspaceRoot, ".loopagent", "conversation.sqlite"))
      : createConversationStore();
    this.conversationManager = createConversationManager(this.conversationStore);
  }

  async dispose(): Promise<void> {
    this.activeRun?.cancel();
    this.editPreviewService.dispose();
    await this.workspaceIntelligence.dispose();
    this.conversationStore.close?.();
  }
```

- [ ] **Step 3: `resolveWebviewView`——握手 + 恢复 + 新对话分发（第 89-122 行）**

```typescript
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };

    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    const nonce = createNonce();

    webviewView.webview.html = createWebviewHtml({
      cspSource: webviewView.webview.cspSource,
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });

    const messageSubscription = webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === "startTask") {
        this.handleStartTask(message, webviewView.webview);
      } else if (message.type === "continueConversation") {
        this.handleContinueConversation(message, webviewView.webview);
      } else if (message.type === "newConversation") {
        this.handleNewConversation();
      } else if (message.type === "webviewReady") {
        this.handleWebviewReady(webviewView.webview);
      }
    });

    webviewView.onDidDispose(() => {
      this.activeRun?.cancel();
      messageSubscription.dispose();
    });
  }

  private handleWebviewReady(webview: vscode.Webview): void {
    const restored = this.conversationManager.loadActiveConversation();
    if (!restored) {
      return;
    }

    this.currentConversationId = restored.conversationId;
    webview.postMessage({
      type: "conversationRestored",
      conversationId: restored.conversationId,
      messages: restored.messages,
    } satisfies HostToWebviewMessage);
  }

  private handleNewConversation(): void {
    this.activeRun?.cancel();
    this.currentConversationId = undefined;
    this.conversationManager.clearActiveConversation();
  }
```

`handleStartTask`、`handleContinueConversation`、`executeRun` 三个方法不用改，原样保留在类里。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: FAIL — `src/webview/App.tsx:227` 仍然报"两个新消息类型没被 `App.tsx` 处理"（`conversationRestored` 这条走完 Task 5 还没解决，`webviewReady`/`newConversation` 是 `WebviewToHostMessage`，跟 `App.tsx` 的 `HostToWebviewMessage` 穷尽性检查无关，`extension.ts` 这边的 `WebviewToHostMessage` 判断分支不需要穷尽——用的是 `if/else if` 不是 `switch`，不会报错）

这是预期状态，Task 6 处理 `App.tsx` 后这条报错才会消失。

- [ ] **Step 5: 编译**

Run: `npm run compile`
Expected: 编译产物生成成功（esbuild 不做类型检查，只要语法正确就能过；`npm run typecheck` 仍然会因为 Task 6 还没做而报错，这一步只是确认 esbuild 层面没问题）

- [ ] **Step 6: 提交**

```bash
git add src/extension.ts
git commit -m "feat(extension): wire persistent conversation store, restore-on-open, new conversation"
```

---

### Task 6: `App.tsx` 处理握手与恢复消息

**Files:**
- Modify: `src/webview/App.tsx:133-239`（host 消息处理 `useEffect`）
- Test: `test/App.test.tsx`

- [ ] **Step 1: 写失败的测试**

在 `test/App.test.tsx` 的 `describe("LoopAgent webview app", ...)` 块内加两个 case：

```typescript
  it("announces readiness to the host on mount", () => {
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    expect(postMessage).toHaveBeenCalledWith({ type: "webviewReady" });
  });

  it("renders a restored conversation pushed by the host", () => {
    render(<App />);

    postHostMessage({
      type: "conversationRestored",
      conversationId: "conv-restored-1",
      messages: [
        { role: "user", content: "What is TypeScript?" },
        { role: "assistant", content: "A typed superset of JavaScript.", reasoning: "recalling definition" },
      ],
    });

    expect(screen.getByText("What is TypeScript?")).toBeInTheDocument();
    expect(screen.getByText("A typed superset of JavaScript.")).toBeInTheDocument();
    expect(screen.queryByText("Start a conversation with LoopAgent.")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- App.test.tsx`
Expected: FAIL——第一个 case 因为 `postMessage` 从未被调用而失败；第二个 case 因为 `conversationRestored` 走了 `default` 分支的穷尽性检查（`const _exhaustive: never = hostMessage;`），TypeScript 编译期就会报错，`npm test` 里 vitest 用 esbuild 转译不做类型检查，运行时会直接落到 `default` 什么都不做，断言里的 `getByText` 找不到元素而失败

- [ ] **Step 3: 实现**

`src/webview/App.tsx` 第 133-239 行的 `useEffect`，在 `switch` 的 `case "conversationStarted"` 后面（第 224 行后、`default` 前）加一个 case：

```typescript
        case "conversationStarted": {
          setIsRunning(true);
          setConversationId(hostMessage.conversationId);
          setTurns((currentTurns) => attachRunToUserTurn(currentTurns, hostMessage.runId, hostMessage.userMessage, createTurnId));
          return;
        }

        case "conversationRestored": {
          setConversationId(hostMessage.conversationId);
          setTurns(
            hostMessage.messages.map((chatMessage, index) =>
              chatMessage.role === "user"
                ? {
                    id: `restored-user-${index}`,
                    role: "user",
                    content: chatMessage.content,
                  }
                : {
                    id: `restored-assistant-${index}`,
                    role: "assistant",
                    runId: `restored-${index}`,
                    provider: defaultProviderName,
                    reasoning: chatMessage.reasoning ?? "",
                    content: chatMessage.content,
                    status: "done",
                  },
            ),
          );
          return;
        }

        default: {
          const _exhaustive: never = hostMessage;
          void _exhaustive;
          return;
        }
```

同一个 `useEffect`（第 133-239 行）注册完监听器后加握手 postMessage，并把 `vscodeApi` 加进依赖数组：

```typescript
  React.useEffect(() => {
    function handleHostMessage(event: MessageEvent<HostToWebviewMessage>) {
      // ...原有实现不变...
    }

    window.addEventListener("message", handleHostMessage);
    vscodeApi.postMessage({ type: "webviewReady" });

    return () => {
      window.removeEventListener("message", handleHostMessage);
    };
  }, [vscodeApi]);
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- App.test.tsx`
Expected: PASS

- [ ] **Step 5: 全量 typecheck**

Run: `npm run typecheck`
Expected: PASS（Task 3/5 遗留的穷尽性检查报错在这一步消失）

- [ ] **Step 6: 提交**

```bash
git add src/webview/App.tsx test/App.test.tsx
git commit -m "feat(webview): announce readiness and render restored conversations"
```

---

### Task 7:"新对话"按钮

**Files:**
- Modify: `src/webview/App.tsx:267-303`（`submitTask` 附近加处理函数）、`:318-329`（header JSX）
- Test: `test/App.test.tsx`

- [ ] **Step 1: 写失败的测试**

在 `test/App.test.tsx` 加：

```typescript
  it("clears the conversation locally and notifies the host when starting a new chat", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.click(screen.getByRole("button", { name: "Explain the active file" }));
    expect(screen.getByText("Explain the active file")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(screen.getByText("Start a conversation with LoopAgent.")).toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith({ type: "newConversation" });
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- App.test.tsx`
Expected: FAIL——找不到 `name: "New chat"` 的按钮

- [ ] **Step 3: 实现**

在 `submitTask` 函数（第 267 行）前加一个处理函数：

```typescript
  function handleNewConversation() {
    setIsRunning(false);
    setOpenMenu(null);
    setTurns([]);
    setConversationId(undefined);
    vscodeApi.postMessage({ type: "newConversation" });
  }

  function submitTask(task: string, mode: TaskMode = taskMode) {
    // ...原有实现不变...
  }
```

header JSX（第 320-329 行）里加按钮：

```tsx
      <header className="app-header">
        <h1>LoopAgent</h1>
        <div className="header-meta">
          <span className={`status-pill status-${isRunning ? "running" : "ready"}`}>
            <span className="status-dot" aria-hidden="true" />
            {isRunning ? "Running" : "Ready"}
          </span>
          <span className="active-model">{selectedModel.label}</span>
          <button type="button" className="chip-button" onClick={handleNewConversation}>
            New chat
          </button>
        </div>
      </header>
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- App.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/webview/App.tsx test/App.test.tsx
git commit -m "feat(webview): add New chat button to clear the active conversation"
```

---

### Task 8: 集成测试——重启后恢复

**Files:**
- Modify: `test/extension/multiTurnConversation.integration.test.ts`

用 `persistentConversationStore` 直接模拟"关掉再打开"，不经过 `extension.ts`（原因见 Task 5 说明：`LoopAgentChatViewProvider` 没有可测试的 fake-vscode 夹具）。

- [ ] **Step 1: 写失败的测试**

在 `test/extension/multiTurnConversation.integration.test.ts` 顶部加 import，`describe` 块内加一个 case：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startAgentRun, type AgentRunner, type AgentRunRequest } from "../../src/extension/agentRunner";
import { createConversationStore } from "../../src/extension/conversation/conversationStore";
import { createPersistentConversationStore } from "../../src/extension/conversation/persistentConversationStore";
import { createConversationManager } from "../../src/extension/conversation/conversationManager";

describe("Multi-turn conversation integration", () => {
  const directories: string[] = [];
  const openStores: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const store of openStores.splice(0)) store.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  // ...原有测试保持不变...

  it("restores the active conversation after the store is reopened, simulating a VS Code restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopagent-restart-"));
    directories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");

    const firstSessionStore = createPersistentConversationStore(databasePath);
    openStores.push(firstSessionStore);
    const firstSessionManager = createConversationManager(firstSessionStore);

    const conversation = firstSessionManager.startConversation();
    firstSessionManager.addUserMessage(conversation.conversationId, "What is TypeScript?");
    firstSessionManager.addAssistantMessage(conversation.conversationId, "A typed superset of JavaScript.");

    // 模拟 VS Code 重启：关闭旧连接，用同一个数据库文件重新打开一个新实例
    firstSessionStore.close();

    const secondSessionStore = createPersistentConversationStore(databasePath);
    openStores.push(secondSessionStore);
    const secondSessionManager = createConversationManager(secondSessionStore);

    const restored = secondSessionManager.loadActiveConversation();
    expect(restored?.conversationId).toBe(conversation.conversationId);
    expect(restored?.messages).toEqual([
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "A typed superset of JavaScript." },
    ]);

    // 恢复后追问，历史要接得上
    secondSessionManager.addUserMessage(conversation.conversationId, "Tell me more");
    const history = secondSessionManager.getConversationHistory(conversation.conversationId);
    expect(history).toHaveLength(3);
    expect(history[2]).toEqual({ role: "user", content: "Tell me more" });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- multiTurnConversation.integration.test.ts`
Expected: FAIL（如果 Task 4 已经完成，这一步理论上应该直接 PASS——如果确实 PASS 也没问题，说明前面的单元测试已经把行为锁死了，跳到 Step 4 提交即可；写这一步的意义是给"重启恢复"这个用户可见场景一个端到端的回归测试锚点，而不是依赖单元测试的间接覆盖）

- [ ] **Step 3: 确认实现（无需改动，Task 4 已完成功能）**

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- multiTurnConversation.integration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/extension/multiTurnConversation.integration.test.ts
git commit -m "test: add restart-and-restore integration scenario for conversation persistence"
```

---

### Task 9: 全量验证

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS，无新增失败

- [ ] **Step 2: 跑类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 跑构建**

Run: `npm run compile`
Expected: 成功生成 `dist/`

- [ ] **Step 4:（可选，如果有可用的 VS Code 调试环境）手动验证真实场景**

用 `/run` 技能或 `npm run debug:vscode` 启动 Extension Development Host，在一个带工作区文件夹的窗口里：
1. 打开 LoopAgent 面板，发一条消息，等回复完成
2. 关闭面板所在的窗口（或重启 Extension Development Host），确认 `<workspace>/.loopagent/conversation.sqlite` 文件存在
3. 重新打开面板，确认历史消息原样恢复，且可以继续追问
4. 点击"New chat"，确认对话清空，磁盘上的 `conversation.sqlite` 里那一行数据被删除
