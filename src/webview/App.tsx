import * as React from "react";
import type { EditFileStat, HostToWebviewMessage, ModelThinkingMode, RunModelSelection, TaskMode } from "../shared/messages";
import type { ConversationSummary } from "../shared/chatTypes";
import { createDefaultVsCodeApi, type VsCodeApi } from "./vscodeApi";
import "./styles.css";

type AppProps = {
  vscodeApi?: VsCodeApi;
};

type UserTurn = {
  id: string;
  role: "user";
  content: string;
  runId?: string;
  pending?: boolean;
};

type ToolCallEntry = {
  callId: string;
  toolName: string;
  input: string;
  output?: string;
  status: "running" | "succeeded" | "failed";
};

type AssistantTurn = {
  id: string;
  role: "assistant";
  runId: string;
  provider: string;
  reasoning: string;
  content: string;
  status: "thinking" | "streaming" | "done" | "error" | "interrupted";
  error?: string;
  toolCalls: ToolCallEntry[];
};

type ChatTurn = UserTurn | AssistantTurn;
type InterruptedRun = { runId: string; conversationId: string; task: string };
type WorkflowProgress = { phase?: string; agents: string[] };
type PendingCommandApproval = { approvalId: string; command: string; cwd: string };
type AppliedEditNotification = { notificationId: string; files: string[]; fileStats: EditFileStat[] };

type AssistantUpdate = (turn: AssistantTurn) => AssistantTurn;

type ModelOption = {
  id: string;
  label: string;
  description: string;
  selection: RunModelSelection;
  supportsThinking: boolean;
};

const defaultProviderName = "LoopAgent";

const modelOptions: ModelOption[] = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek v4 Flash",
    description: "Real DeepSeek provider",
    selection: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "enabled",
    },
    supportsThinking: true,
  },
];

const suggestedTasks = ["Explain the active file", "Find where this is implemented"];

function TaskSuggestions({ onSelect }: { onSelect(task: string): void }) {
  return (
    <div className="task-suggestions" aria-label="Suggested tasks">
      {suggestedTasks.map((task) => (
        <button key={task} type="button" className="suggestion-button" onClick={() => onSelect(task)}>
          {task}
        </button>
      ))}
    </div>
  );
}

export function App({ vscodeApi = createDefaultVsCodeApi() }: AppProps) {
  const [message, setMessage] = React.useState("");
  const [isRunning, setIsRunning] = React.useState(false);
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [selectedModelId, setSelectedModelId] = React.useState(modelOptions[0].id);
  const [thinkingMode, setThinkingMode] = React.useState<ModelThinkingMode>("enabled");
  const [taskMode, setTaskMode] = React.useState<TaskMode>("edit");
  const [openMenu, setOpenMenu] = React.useState<"model" | "thinking" | "history" | null>(null);
  const [conversationId, setConversationId] = React.useState<string | undefined>(undefined);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [interruptedRun, setInterruptedRun] = React.useState<InterruptedRun | undefined>();
  const [workflowProgress, setWorkflowProgress] = React.useState<Record<string, WorkflowProgress>>({});
  const [pendingApprovals, setPendingApprovals] = React.useState<PendingCommandApproval[]>([]);
  const [appliedEdits, setAppliedEdits] = React.useState<AppliedEditNotification[]>([]);
  const nextTurnId = React.useRef(0);
  const composerToolsRef = React.useRef<HTMLDivElement | null>(null);
  const historyMenuRef = React.useRef<HTMLDivElement | null>(null);
  const ignoredRunIdsRef = React.useRef<Set<string>>(new Set());

  const selectedModel = modelOptions.find((option) => option.id === selectedModelId) ?? modelOptions[0];
  const effectiveThinkingMode = selectedModel.supportsThinking ? thinkingMode : "disabled";

  function createTurnId(prefix: string) {
    const id = `${prefix}-${nextTurnId.current}`;
    nextTurnId.current += 1;
    return id;
  }

  function createAssistantTurn(runId: string, provider = defaultProviderName): AssistantTurn {
    return {
      id: createTurnId("assistant"),
      role: "assistant",
      runId,
      provider,
      reasoning: "",
      content: "",
      status: "thinking",
      toolCalls: [],
    };
  }

  function updateAssistantTurn(runId: string, update: AssistantUpdate, provider?: string) {
    setTurns((currentTurns) => {
      const assistantIndex = currentTurns.findIndex((turn) => turn.role === "assistant" && turn.runId === runId);

      if (assistantIndex === -1) {
        return [...currentTurns, update(createAssistantTurn(runId, provider))];
      }

      return currentTurns.map((turn, index) => {
        if (index !== assistantIndex || turn.role !== "assistant") {
          return turn;
        }

        return update(turn);
      });
    });
  }

  React.useEffect(() => {
    function handleHostMessage(event: MessageEvent<HostToWebviewMessage>) {
      const hostMessage = event.data;

      if (!hostMessage || typeof hostMessage.type !== "string") {
        return;
      }

      if (
        "runId" in hostMessage &&
        ignoredRunIdsRef.current.has(hostMessage.runId) &&
        hostMessage.type !== "runInterrupted"
      ) {
        if (hostMessage.type === "runFinished" || hostMessage.type === "runFailed") {
          ignoredRunIdsRef.current.delete(hostMessage.runId);
        }
        return;
      }

      switch (hostMessage.type) {
        case "runStarted": {
          setIsRunning(true);
          setTurns((currentTurns) => attachRunToUserTurn(currentTurns, hostMessage.runId, hostMessage.task, createTurnId));
          return;
        }

        case "assistantStarted": {
          setIsRunning(true);
          updateAssistantTurn(
            hostMessage.runId,
            (turn) => ({
              ...turn,
              provider: hostMessage.provider,
              status: "thinking",
            }),
            hostMessage.provider,
          );
          return;
        }

        case "assistantThinking": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            status: turn.content.length > 0 ? "streaming" : "thinking",
          }));
          return;
        }

        case "assistantReasoningDelta": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            reasoning: `${turn.reasoning}${hostMessage.content}`,
            status: turn.content.length > 0 ? "streaming" : "thinking",
          }));
          return;
        }

        case "assistantDelta": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            content: `${turn.content}${hostMessage.content}`,
            status: "streaming",
          }));
          return;
        }

        case "assistantFinished": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            status: "done",
          }));
          return;
        }

        case "agentEvent": {
          return;
        }

        case "toolCallStarted": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            toolCalls: [
              ...turn.toolCalls,
              {
                callId: hostMessage.callId,
                toolName: hostMessage.toolName,
                input: hostMessage.input,
                status: "running",
              },
            ],
          }));
          return;
        }

        case "toolCallFinished": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            toolCalls: turn.toolCalls.map((entry) =>
              entry.callId === hostMessage.callId
                ? { ...entry, status: hostMessage.succeeded ? "succeeded" : "failed", output: hostMessage.output }
                : entry,
            ),
          }));
          return;
        }

        case "commandApprovalRequested": {
          setPendingApprovals((current) => [
            ...current,
            { approvalId: hostMessage.approvalId, command: hostMessage.command, cwd: hostMessage.cwd },
          ]);
          return;
        }

        case "editApplied": {
          setAppliedEdits((current) => [
            ...current,
            { notificationId: hostMessage.notificationId, files: hostMessage.files, fileStats: hostMessage.fileStats },
          ]);
          return;
        }

        case "workflowStateChanged": {
          setWorkflowProgress((current) => ({
            ...current,
            [hostMessage.runId]: { phase: hostMessage.phase, agents: current[hostMessage.runId]?.agents ?? [] },
          }));
          return;
        }

        case "subagentStateChanged": {
          setWorkflowProgress((current) => {
            const progress = current[hostMessage.runId] ?? { agents: [] };
            const agent = `${hostMessage.agentId}: ${hostMessage.status}`;
            return { ...current, [hostMessage.runId]: { ...progress, agents: [...progress.agents.filter((item) => !item.startsWith(`${hostMessage.agentId}:`)), agent] } };
          });
          return;
        }

        case "runFinished": {
          setIsRunning(false);
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            status: "done",
          }));
          return;
        }

        case "runFailed": {
          setIsRunning(false);
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            error: hostMessage.message,
            status: "error",
          }));
          return;
        }

        case "runInterrupted": {
          ignoredRunIdsRef.current.delete(hostMessage.runId);
          setInterruptedRun({ runId: hostMessage.runId, conversationId: hostMessage.conversationId, task: hostMessage.task });
          setIsRunning(false);
          updateAssistantTurn(hostMessage.runId, (turn) => ({ ...turn, status: "interrupted" }));
          return;
        }

        case "conversationStarted": {
          setIsRunning(true);
          setConversationId(hostMessage.conversationId);
          setTurns((currentTurns) => attachRunToUserTurn(currentTurns, hostMessage.runId, hostMessage.userMessage, createTurnId));
          return;
        }

        case "conversationRestored": {
          setInterruptedRun(undefined);
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
                    toolCalls: [],
                  },
            ),
          );
          return;
        }

        case "conversationList": {
          setConversations(hostMessage.conversations);
          return;
        }

        default: {
          const _exhaustive: never = hostMessage;
          void _exhaustive;
          return;
        }
      }
    }

    window.addEventListener("message", handleHostMessage);
    vscodeApi.postMessage({ type: "webviewReady" });

    return () => {
      window.removeEventListener("message", handleHostMessage);
    };
  }, [vscodeApi]);

  React.useEffect(() => {
    if (openMenu === null) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      const insideComposerTools = composerToolsRef.current?.contains(target) ?? false;
      const insideHistoryMenu = historyMenuRef.current?.contains(target) ?? false;
      if (!insideComposerTools && !insideHistoryMenu) {
        setOpenMenu(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenu(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenu]);

  function interruptActiveRun() {
    let runId: string | undefined;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn.role === "user" && turn.runId) {
        runId = turn.runId;
        break;
      }
    }

    if (runId) {
      ignoredRunIdsRef.current.add(runId);
      setTurns((currentTurns) =>
        currentTurns
          .filter(
            (turn) =>
              turn.role !== "assistant" ||
              turn.runId !== runId ||
              Boolean(turn.content || turn.reasoning || turn.error),
          )
          .map((turn) =>
            turn.role === "assistant" && turn.runId === runId ? { ...turn, status: "done" as const } : turn,
          ),
      );
    }

    setIsRunning(false);
  }

  function handleStop() {
    interruptActiveRun();
    vscodeApi.postMessage({ type: "stopRun" });
  }

  function resolveApproval(approvalId: string, approved: boolean) {
    setPendingApprovals((current) => current.filter((approval) => approval.approvalId !== approvalId));
    vscodeApi.postMessage({ type: "commandApprovalResolved", approvalId, approved });
  }

  function dismissAppliedEdit(notificationId: string) {
    setAppliedEdits((current) => current.filter((notification) => notification.notificationId !== notificationId));
  }

  function revertEditFile(notificationId: string, path: string) {
    setAppliedEdits((current) =>
      current
        .map((notification) =>
          notification.notificationId === notificationId
            ? {
                ...notification,
                files: notification.files.filter((file) => file !== path),
                fileStats: notification.fileStats.filter((stat) => stat.path !== path),
              }
            : notification,
        )
        .filter((notification) => notification.files.length > 0),
    );
    vscodeApi.postMessage({ type: "editRevertRequested", notificationId, paths: [path] });
  }

  function revertAllEditFiles(notificationId: string) {
    dismissAppliedEdit(notificationId);
    vscodeApi.postMessage({ type: "editRevertRequested", notificationId, paths: [] });
  }

  function openEditFile(notificationId: string, path: string) {
    vscodeApi.postMessage({ type: "editFileOpened", notificationId, path });
  }

  function resumeInterruptedRun() {
    if (!interruptedRun || isRunning) return;

    const runId = createTurnId("run");
    setInterruptedRun(undefined);
    setIsRunning(true);
    setTurns((currentTurns) => {
      const userIndex = findLastIndex(
        currentTurns,
        (turn): turn is UserTurn => turn.role === "user" && turn.content === interruptedRun.task,
      );
      if (userIndex === -1) return currentTurns;
      return currentTurns.map((turn, index) =>
        index === userIndex && turn.role === "user" ? { ...turn, runId, pending: true } : turn,
      );
    });
    vscodeApi.postMessage({ type: "resumeRun", runId, conversationId: interruptedRun.conversationId });
  }

  function handleNewConversation() {
    interruptActiveRun();
    setOpenMenu(null);
    setTurns([]);
    setConversationId(undefined);
    vscodeApi.postMessage({ type: "newConversation" });
  }

  function handleSwitchConversation(targetConversationId: string) {
    if (targetConversationId === conversationId) {
      setOpenMenu(null);
      return;
    }
    interruptActiveRun();
    setOpenMenu(null);
    vscodeApi.postMessage({ type: "switchConversation", conversationId: targetConversationId });
  }

  function submitTask(task: string, mode: TaskMode = taskMode) {
    const trimmedMessage = task.trim();

    if (!trimmedMessage || isRunning) {
      return;
    }

    const runModel: RunModelSelection = {
      ...selectedModel.selection,
      thinking: effectiveThinkingMode,
    };
    const runId = createTurnId("run");

    setIsRunning(true);
    setOpenMenu(null);
    setTurns((currentTurns) => [
      ...currentTurns,
      {
        id: createTurnId("user"),
        role: "user",
        content: trimmedMessage,
        runId,
        pending: true,
      },
    ]);
    setMessage("");

    if (conversationId) {
      vscodeApi.postMessage({
        type: "continueConversation",
        runId,
        conversationId,
        userMessage: trimmedMessage,
        mode,
        model: runModel,
      });
    } else {
      vscodeApi.postMessage({ type: "startTask", runId, task: trimmedMessage, mode, model: runModel });
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitTask(message);
  }

  function selectModel(option: ModelOption) {
    setSelectedModelId(option.id);
    if (!option.supportsThinking) {
      setThinkingMode("disabled");
    }
    setOpenMenu(null);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>LoopAgent</h1>
        <div className="header-meta">
          <span className={`status-pill status-${isRunning ? "running" : "ready"}`}>
            <span className="status-dot" aria-hidden="true" />
            {isRunning ? "Running" : "Ready"}
          </span>
          <span className="active-model">{selectedModel.label}</span>
          <div className="tool-menu-anchor" ref={historyMenuRef}>
            <button type="button" className="chip-button" onClick={() => setOpenMenu(openMenu === "history" ? null : "history")}>
              History
            </button>
            {openMenu === "history" ? (
              <HistoryMenu conversations={conversations} activeConversationId={conversationId} onSelect={handleSwitchConversation} />
            ) : null}
          </div>
          <button type="button" className="chip-button" onClick={handleNewConversation}>
            New chat
          </button>
        </div>
      </header>

      <section className="chat-log" aria-label="Conversation">
        {turns.length === 0 ? (
          <>
            <p className="empty-state">Start a conversation with LoopAgent.</p>
            <TaskSuggestions onSelect={(task) => submitTask(task, "ask")} />
          </>
        ) : (
          turns.map((turn) => {
            if (turn.role === "user") {
              return <UserMessage key={turn.id} turn={turn} />;
            }

            return (
              <AssistantMessage
                key={turn.id}
                turn={turn}
                workflow={workflowProgress[turn.runId]}
                onResume={
                  turn.status === "interrupted" && interruptedRun?.runId === turn.runId
                    ? resumeInterruptedRun
                    : undefined
                }
              />
            );
          })
        )}
      </section>

      {pendingApprovals.length > 0 ? (
        <div className="command-approvals" aria-label="Pending command approvals">
          {pendingApprovals.map((approval) => (
            <CommandApprovalCard key={approval.approvalId} approval={approval} onResolve={resolveApproval} />
          ))}
        </div>
      ) : null}

      {appliedEdits.length > 0 ? (
        <div className="edit-approvals" aria-label="Applied code changes">
          {appliedEdits.map((notification) => (
            <EditApprovalCard
              key={notification.notificationId}
              notification={notification}
              onDismiss={dismissAppliedEdit}
              onRevertFile={revertEditFile}
              onRevertAll={revertAllEditFiles}
              onOpenFile={openEditFile}
            />
          ))}
        </div>
      ) : null}

      <form className="chat-composer" aria-label="Chat composer" onSubmit={handleSubmit}>
        <label htmlFor="message-input">Message</label>
        <textarea
          id="message-input"
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          placeholder="Ask LoopAgent anything about this workspace."
          rows={3}
        />

        <div className="composer-toolbar">
          <div className="composer-tools" ref={composerToolsRef}>
            <div className="mode-switch" role="group" aria-label="Mode">
              <button type="button" className="mode-button" aria-pressed={taskMode === "edit"} onClick={() => setTaskMode("edit")}>
                Edit
              </button>
              <button type="button" className="mode-button" aria-pressed={taskMode === "ask"} onClick={() => setTaskMode("ask")}>
                Ask
              </button>
            </div>

            <div className="tool-menu-anchor">
              <button type="button" className="chip-button" onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}>
                {selectedModel.label}
              </button>
              {openMenu === "model" ? <ModelMenu selectedModel={selectedModel} onSelect={selectModel} /> : null}
            </div>

            <div className="tool-menu-anchor">
              <button
                type="button"
                className="chip-button"
                disabled={!selectedModel.supportsThinking}
                onClick={() => setOpenMenu(openMenu === "thinking" ? null : "thinking")}
              >
                {selectedModel.supportsThinking ? `Think: ${thinkingMode === "enabled" ? "On" : "Off"}` : "Think: Not supported"}
              </button>
              {openMenu === "thinking" && selectedModel.supportsThinking ? (
                <ThinkingMenu thinkingMode={thinkingMode} onSelect={setThinkingMode} onClose={() => setOpenMenu(null)} />
              ) : null}
            </div>
          </div>

          {isRunning ? (
            <button type="button" onClick={handleStop}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!message.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

function ModelMenu({ selectedModel, onSelect }: { selectedModel: ModelOption; onSelect(option: ModelOption): void }) {
  return (
    <div className="composer-menu" role="menu" aria-label="Model">
      {modelOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitem"
          className="menu-item"
          aria-label={`${option.label} ${option.description}`}
          aria-current={option.id === selectedModel.id ? "true" : undefined}
          onClick={() => onSelect(option)}
        >
          <span>{option.label}</span>
          <span>{option.description}</span>
        </button>
      ))}
    </div>
  );
}

function ThinkingMenu({
  thinkingMode,
  onSelect,
  onClose,
}: {
  thinkingMode: ModelThinkingMode;
  onSelect(mode: ModelThinkingMode): void;
  onClose(): void;
}) {
  function select(mode: ModelThinkingMode) {
    onSelect(mode);
    onClose();
  }

  return (
    <div className="composer-menu" role="menu" aria-label="Deep thinking">
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        aria-label="Off Uses direct answer mode"
        aria-current={thinkingMode === "disabled" ? "true" : undefined}
        onClick={() => select("disabled")}
      >
        <span>Off</span>
        <span>Uses direct answer mode</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        aria-label="On Enables provider reasoning mode"
        aria-current={thinkingMode === "enabled" ? "true" : undefined}
        onClick={() => select("enabled")}
      >
        <span>On</span>
        <span>Enables provider reasoning mode</span>
      </button>
    </div>
  );
}

function HistoryMenu({
  conversations,
  activeConversationId,
  onSelect,
}: {
  conversations: ConversationSummary[];
  activeConversationId: string | undefined;
  onSelect(conversationId: string): void;
}) {
  return (
    <div className="composer-menu history-menu" role="menu" aria-label="History">
      {conversations.length === 0 ? (
        <p className="menu-empty">No past conversations yet.</p>
      ) : (
        conversations.map((conversation) => (
          <button
            key={conversation.conversationId}
            type="button"
            role="menuitem"
            className="menu-item"
            aria-current={conversation.conversationId === activeConversationId ? "true" : undefined}
            onClick={() => onSelect(conversation.conversationId)}
          >
            <span>{conversation.preview || "(empty conversation)"}</span>
          </button>
        ))
      )}
    </div>
  );
}

function CommandApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingCommandApproval;
  onResolve(approvalId: string, approved: boolean): void;
}) {
  return (
    <div className="command-approval-card" role="alertdialog" aria-label="LoopAgent wants to run a command">
      <p className="command-approval-title">LoopAgent wants to run a command</p>
      <pre className="command-approval-command">{approval.command}</pre>
      <p className="command-approval-cwd">Working directory: {approval.cwd}</p>
      <div className="command-approval-actions">
        <button type="button" className="chip-button" onClick={() => onResolve(approval.approvalId, false)}>
          Reject
        </button>
        <button type="button" className="chip-button chip-button-primary" onClick={() => onResolve(approval.approvalId, true)}>
          Run
        </button>
      </div>
    </div>
  );
}

const FILE_EXTENSION_ICONS: Record<string, { label: string; color: string }> = {
  ts: { label: "TS", color: "#3178c6" },
  tsx: { label: "TS", color: "#3178c6" },
  js: { label: "JS", color: "#e8c547" },
  jsx: { label: "JS", color: "#e8c547" },
  json: { label: "{}", color: "#9aa0a6" },
  css: { label: "#", color: "#a855f7" },
  md: { label: "M", color: "#9aa0a6" },
  py: { label: "PY", color: "#4b8bbe" },
  java: { label: "J", color: "#e76f00" },
  go: { label: "Go", color: "#00add8" },
  rs: { label: "RS", color: "#dea584" },
};

function getFileIcon(path: string): { label: string; color: string } {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return FILE_EXTENSION_ICONS[extension] ?? { label: extension.slice(0, 2).toUpperCase() || "?", color: "#9aa0a6" };
}

function splitFilePath(path: string): { name: string; dir: string } {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return { name: path, dir: "" };
  return { name: path.slice(lastSlash + 1), dir: path.slice(0, lastSlash) };
}

function EditApprovalCard({
  notification,
  onDismiss,
  onRevertFile,
  onRevertAll,
  onOpenFile,
}: {
  notification: AppliedEditNotification;
  onDismiss(notificationId: string): void;
  onRevertFile(notificationId: string, path: string): void;
  onRevertAll(notificationId: string): void;
  onOpenFile(notificationId: string, path: string): void;
}) {
  const [query, setQuery] = React.useState("");

  const statByPath = React.useMemo(() => {
    const map = new Map<string, EditFileStat>();
    for (const stat of notification.fileStats) map.set(stat.path, stat);
    return map;
  }, [notification.fileStats]);

  const totals = React.useMemo(
    () =>
      notification.fileStats.reduce(
        (acc, stat) => ({ added: acc.added + stat.added, removed: acc.removed + stat.removed }),
        { added: 0, removed: 0 },
      ),
    [notification.fileStats],
  );

  const visibleFiles = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "") {
      return notification.files;
    }
    return notification.files.filter((path) => path.toLowerCase().includes(trimmed));
  }, [notification.files, query]);

  return (
    <div className="edit-approval-card" role="status" aria-label="LoopAgent applied code changes">
      <div className="edit-approval-header">
        <span className="edit-approval-title">已更改 {notification.files.length} 个文件</span>
        <span className="edit-approval-total-stat">
          <span className="edit-approval-stat-added">+{totals.added}</span>
          <span className="edit-approval-stat-removed">-{totals.removed}</span>
        </span>
        <div className="edit-approval-header-actions">
          <button type="button" className="chip-button chip-button-primary" onClick={() => onDismiss(notification.notificationId)}>
            保留
          </button>
          <button type="button" className="chip-button" onClick={() => onRevertAll(notification.notificationId)}>
            撤销
          </button>
        </div>
      </div>

      <input
        type="text"
        className="edit-approval-search"
        placeholder="Search files..."
        aria-label="Search changed files"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      <ul className="edit-approval-file-list">
        {visibleFiles.map((path) => {
          const stat = statByPath.get(path);
          const icon = getFileIcon(path);
          const { name, dir } = splitFilePath(path);

          return (
            <li key={path} className="edit-approval-file-row">
              <span className="edit-approval-file-icon" style={{ color: icon.color }} aria-hidden="true">
                {icon.label}
              </span>
              <button
                type="button"
                className="edit-approval-file-button"
                aria-label={path}
                onClick={() => onOpenFile(notification.notificationId, path)}
              >
                <span className="edit-approval-file-name">{name}</span>
                {dir ? <span className="edit-approval-file-dir">{dir}</span> : null}
              </button>
              {stat ? (
                <span className="edit-approval-file-stat" aria-label={`${stat.added} added, ${stat.removed} removed`}>
                  <span className="edit-approval-stat-added">+{stat.added}</span>
                  <span className="edit-approval-stat-removed">-{stat.removed}</span>
                </span>
              ) : null}
              <button
                type="button"
                className="edit-approval-file-revert"
                aria-label={`Revert ${path}`}
                onClick={() => onRevertFile(notification.notificationId, path)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UserMessage({ turn }: { turn: UserTurn }) {
  return (
    <article className="message message-user message-user-right">
      <div className="message-meta">You</div>
      <div className="message-body">{turn.content}</div>
    </article>
  );
}

function AssistantMessage({ turn, workflow, onResume }: { turn: AssistantTurn; workflow?: WorkflowProgress; onResume?: () => void }) {
  const [isProcessOpen, setIsProcessOpen] = React.useState(turn.status !== "done");
  const previousStatus = React.useRef(turn.status);

  React.useEffect(() => {
    if (turn.status === "done" && previousStatus.current !== "done") {
      setIsProcessOpen(false);
    }
    previousStatus.current = turn.status;
  }, [turn.status]);

  return (
    <article className={`message message-assistant${turn.status === "error" ? " message-error" : ""}`}>
      <div className="message-meta">
        <span>{turn.provider}</span>
        <span>{formatAssistantStatus(turn.status)}</span>
      </div>

      {turn.reasoning.length > 0 ? (
        <details
          className="process-details"
          open={isProcessOpen}
          onToggle={(event) => setIsProcessOpen(event.currentTarget.open)}
        >
          <summary>思考过程</summary>
          <div className="reasoning-content">{turn.reasoning}</div>
        </details>
      ) : null}

      {turn.toolCalls.length > 0 ? (
        <details
          className="tool-calls-details"
          open={isProcessOpen}
          onToggle={(event) => setIsProcessOpen(event.currentTarget.open)}
        >
          <summary>工具调用</summary>
          <ul className="tool-calls-list">
            {turn.toolCalls.map((entry) => (
              <li key={entry.callId} className={`tool-call-entry tool-call-${entry.status}`}>
                <div className="tool-call-header">
                  <span className="tool-call-status-icon" aria-hidden="true">
                    {entry.status === "running" ? "⏳" : entry.status === "succeeded" ? "✓" : "✗"}
                  </span>
                  <span className="tool-call-name">{entry.toolName}</span>
                  <span className="tool-call-input">{entry.input}</span>
                </div>
                {entry.output !== undefined ? (
                  <details className="tool-call-output-details">
                    <summary>输出</summary>
                    <pre className="tool-call-output">{entry.output}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {turn.content.length > 0 ? <div className="message-body assistant-answer">{turn.content}</div> : null}
      {workflow?.phase ? (
        <div className="workflow-timeline" aria-label="Workflow progress">
          <span>{workflow.phase}</span>
          {workflow.agents.map((agent) => <span key={agent}>{agent}</span>)}
        </div>
      ) : null}
      {turn.status !== "done" && turn.content.length === 0 && !turn.error ? (
        <div className="assistant-placeholder">Waiting for response...</div>
      ) : null}
      {turn.error ? (
        <p className="error-message" role="alert">
          {turn.error}
        </p>
      ) : null}
      {onResume ? (
        <button type="button" onClick={onResume}>
          Resume
        </button>
      ) : null}
    </article>
  );
}

function attachRunToUserTurn(
  turns: ChatTurn[],
  runId: string,
  task: string,
  createTurnId: (prefix: string) => string,
): ChatTurn[] {
  const pendingUserIndex = findLastIndex(
    turns,
    (turn): turn is UserTurn => turn.role === "user" && turn.pending === true && turn.content === task,
  );

  if (pendingUserIndex === -1) {
    return [
      ...turns,
      {
        id: createTurnId("user"),
        role: "user",
        content: task,
        runId,
      },
    ];
  }

  return turns.map((turn, index) => {
    if (index !== pendingUserIndex || turn.role !== "user") {
      return turn;
    }

    return {
      ...turn,
      runId,
      pending: false,
    };
  });
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }

  return -1;
}

function formatAssistantStatus(status: AssistantTurn["status"]): string {
  if (status === "done") {
    return "Done";
  }

  if (status === "error") {
    return "Error";
  }

  if (status === "streaming") {
    return "Responding";
  }

  if (status === "interrupted") {
    return "Interrupted";
  }

  return "Thinking";
}
