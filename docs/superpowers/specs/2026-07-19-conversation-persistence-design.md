# 多轮对话持久化设计

> 状态：设计阶段
>
> 前置规格：无独立设计文档，前置实现见 `docs/superpowers/plans/2026-07-18-multi-turn-conversation-plan.md`（内存版对话状态管理，本设计是其步骤 8.1"持久化存储接口"的延续）
>
> 本规格处理：把当前进程内存里的活跃对话，落盘到工作区本地 SQLite，重开面板/重启 VS Code 后自动恢复

## 背景

`ConversationStore`（`src/extension/conversation/conversationStore.ts`）目前用 `Map<string, ConversationContext>` 存对话，进程一退出（VS Code 重启、webview 销毁、插件更新）当前对话就丢失。webview 侧（`App.tsx`）只维护单个 `conversationId`，没有历史列表/切换 UI——是"单活跃对话"模型，不是多会话管理器。

`.loopagent/` 目录（原 `.codegraph/`，见代码索引持久化改动）已经建立了"工作区本地、不进 git、随项目走"的持久化目录约定，本次沿用这个约定，但用独立的 SQLite 文件，不复用代码索引那个库（避免和它的 writer-lease 多窗口仲裁机制纠缠——对话持久化不需要那么严谨的并发控制）。

## 目标

1. 当前活跃对话（`conversationId` + 全部消息）持久化到 `.loopagent/conversation.sqlite`
2. 重新打开面板 / 重启 VS Code 后，自动恢复上一次未结束的对话，包括历史消息在聊天界面里正确渲染
3. 提供一个最小的"新对话"入口，点击后清空当前对话（UI 和持久化数据都清）
4. 无工作区文件夹时优雅降级为纯内存存储（跟 `vscodeWorkspaceIntelligence.ts` 的降级模式一致）

## 非目标

- 不做历史对话列表 UI（看不到、也切换不了"上上一次"的对话）
- 不做多对话并存/多标签会话
- 不处理多个 VS Code 窗口同时打开同一工作区、并发写同一个 `conversation.sqlite` 的冲突——最后写入的窗口胜出，不做仲裁
- 不迁移插件更新前已经存在的纯内存对话数据——本次改动上线后，用户当时正在进行的内存对话会丢失这一次，之后才开始持久化
- 不支持对话导出/搜索/按时间浏览

## 用户可见行为

- 用户在 LoopAgent 面板里正常对话；关闭再打开面板，或重启 VS Code 再打开面板，之前的对话历史原样显示，可以直接继续追问
- 面板头部新增一个"新对话"按钮，点击后立即清空当前对话（UI 侧同步清空，不等待后端确认），下一条消息会开始一个全新的对话，旧对话数据同时从磁盘删除

## 涉及文件或模块

| 文件 | 改动 |
|------|------|
| `src/extension/conversation/persistentConversationStore.ts`（新） | 实现 `ConversationStore` 接口的 SQLite 持久化版本，另加 `loadActiveConversation()`/`clearActiveConversation()` |
| `src/extension/conversation/conversationStore.ts` | 加 `clearActiveConversation()`（内存版实现为清空 Map），保持接口一致 |
| `src/extension.ts` | 构造函数按是否有工作区文件夹选择持久化/内存版 store；`resolveWebviewView` 里加载并推送恢复的对话；消息分发加 `newConversation` 处理 |
| `src/shared/messages.ts` | `HostToWebviewMessage` 加 `conversationRestored`；`WebviewToHostMessage` 加 `newConversation` |
| `src/webview/App.tsx` | 处理 `conversationRestored`（映射为 `ChatTurn[]` 并设置 `conversationId`）；新增"新对话"按钮及点击处理 |
| `test/extension/conversation/persistentConversationStore.test.ts`（新） | 持久化 store 的增删改查、跨实例恢复、清空 |
| `test/extension/multiTurnConversation.integration.test.ts` | 加"重启后恢复"场景 |
| `test/App.test.tsx` | 加 `conversationRestored` 渲染、"新对话"按钮交互的测试 case |

## 关键设计决策

### 单行表，不做消息级关系表

```sql
CREATE TABLE IF NOT EXISTS conversation (
  conversation_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

表里最多一行，代表"当前活跃对话"。`messages: ChatMessage[]` 整体序列化成一段 JSON 存在 `messages_json`。曾经考虑按消息拆成独立的 `messages` 表（1:N 关系），但当前没有"按消息查询/检索历史"的需求，拆表是为不存在的功能预留复杂度，按 YAGNI 原则否掉。

### 同步写、无 worker 线程

`addUserMessage`/`addAssistantMessage` 每轮对话各调用一次（不是流式高频写，流式 token 走的是独立的 `assistantDelta` host 消息，不经过 `ConversationStore`），数据量是一份 JSON 文本，`node:sqlite` 的 `DatabaseSync` 同步 API 直接在 extension host 主线程操作即可，不需要像代码索引那样起 worker 线程 + writer lease。

### 独立 SQLite 文件，不复用 code-index.sqlite

`.loopagent/conversation.sqlite` 单开一个文件。代码索引的 `SqliteIndexStore` 有 writer-lease 多窗口仲裁、worker 线程协议，是为高频增量索引设计的重量级机制；对话持久化只是单行覆盖式读写，接入那套机制收益低、耦合重。两个文件都在 `.loopagent/.gitignore` 的 `*.sqlite` 规则覆盖范围内，不用改 `.gitignore`。

### 新对话 = 删除旧行 + 前端立即清空

点击"新对话"按钮时：
1. `App.tsx` 本地立即 `setTurns([])` + `setConversationId(undefined)`，不等待 host 确认——保证交互是即时的
2. 同时发 `newConversation` 消息给 host
3. host 侧清空 `currentConversationId`，调用 `store.clearActiveConversation()`（持久化版执行 `DELETE FROM conversation`，内存版清空 Map）

下一条用户消息发送时，`conversationId` 是 `undefined`，会走现有的 `startTask` 分支（而不是 `continueConversation`），自然创建一个新对话——这条路径不用改。

### 恢复流程接入点

`resolveWebviewView()` 里 webview 的 HTML/脚本注入完成后，调用 `store.loadActiveConversation()`。如果有值，postMessage 一条 `conversationRestored`，webview 收到后把 `ChatMessage[]` 映射成 `ChatTurn[]`：
- `role: "user"` → `UserTurn`
- `role: "assistant"` → `AssistantTurn`，`status` 固定为 `"done"`，`runId` 用 `restored-${index}` 占位（历史消息不会再被 `assistantDelta` 等流式消息按 `runId` 匹配到，占位符不冲突即可），`provider` 用默认值 `defaultProviderName`

`currentConversationId`（host 侧）和 `conversationId`（webview 侧 state）都设置为恢复出来的 `conversationId`，之后用户追问自然走 `continueConversation` 分支。

## 验证命令

```bash
npm test -- persistentConversationStore
npm test -- multiTurnConversation.integration
npm test -- App.test
npm run build
```

## 已知后续工作

- 多窗口并发写同一个 `conversation.sqlite` 目前不仲裁，如果未来需要更强的一致性保证，可以参考 `SqliteIndexStore` 的 writer-lease 模式
- 历史对话列表/多会话切换如果后续有需求，需要把单行表升级成关系表，是一次独立的设计
