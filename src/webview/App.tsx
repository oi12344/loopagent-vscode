import * as React from "react";
import type { EditFileStat, HostToWebviewMessage, ModelThinkingMode, RunModelSelection } from "../shared/messages";
import type { CodeReviewIssue, CodeReviewReport, ConversationSummary } from "../shared/chatTypes";
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
type WorkflowPlanStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type WorkflowPlanItem = {
  id: string;
  task: string;
  role?: "explorer" | "reviewer" | "planner" | "executor";
  dependsOn: string[];
  status: WorkflowPlanStatus;
};
type WorkflowProgress = { phase?: string; agents: WorkflowPlanItem[]; step?: number; stateVersion?: number; stopReason?: string };
type PendingCommandApproval = { approvalId: string; command: string; cwd: string };
type AppliedEditNotification = { notificationId: string; files: string[]; fileStats: EditFileStat[]; error?: string };

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

        case "assistantContentReset": {
          updateAssistantTurn(hostMessage.runId, (turn) => ({
            ...turn,
            content: "",
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
          if (hostMessage.succeeded) {
            try {
              const workflowState = (JSON.parse(hostMessage.output) as { workflowState?: { step?: number; stateVersion?: number; stopReason?: string } }).workflowState;
              if (workflowState) {
                setWorkflowProgress((current) => ({
                  ...current,
                  [hostMessage.runId]: {
                    ...(current[hostMessage.runId] ?? { agents: [] }),
                    step: workflowState.step,
                    stateVersion: workflowState.stateVersion,
                    stopReason: workflowState.stopReason,
                  },
                }));
              }
            } catch {
              // Tool output may be plain text; the existing tool-call card remains the source of truth.
            }
          }
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

        case "editRevertResult": {
          setAppliedEdits((current) => current.flatMap((notification) => {
            if (notification.notificationId !== hostMessage.notificationId) return [notification];
            if (!hostMessage.succeeded) return [{ ...notification, error: hostMessage.message }];
            if (hostMessage.paths.length === 0) return [];
            const reverted = new Set(hostMessage.paths);
            const files = notification.files.filter((path) => !reverted.has(path));
            const fileStats = notification.fileStats.filter((stat) => !reverted.has(stat.path));
            return files.length > 0 ? [{ ...notification, files, fileStats, error: undefined }] : [];
          }));
          return;
        }

        case "subagentPlanCreated": {
          setWorkflowProgress((current) => {
            const progress = current[hostMessage.runId] ?? { agents: [] };
            const item: WorkflowPlanItem = {
              id: hostMessage.agentId,
              task: hostMessage.task,
              role: hostMessage.role,
              dependsOn: hostMessage.dependsOn,
              status: "pending",
            };
            return {
              ...current,
              [hostMessage.runId]: {
                ...progress,
                agents: [...progress.agents.filter((agent) => agent.id !== item.id), item],
              },
            };
          });
          return;
        }

        case "subagentStateChanged": {
          setWorkflowProgress((current) => {
            const progress = current[hostMessage.runId] ?? { agents: [] };
            const hasAgent = progress.agents.some((agent) => agent.id === hostMessage.agentId);
            const agents = hasAgent
              ? progress.agents.map((agent) =>
                  agent.id === hostMessage.agentId ? { ...agent, status: hostMessage.status } : agent,
                )
              : [
                  ...progress.agents,
                  {
                    id: hostMessage.agentId,
                    task: hostMessage.agentId,
                    dependsOn: [],
                    status: hostMessage.status,
                  },
                ];
            return { ...current, [hostMessage.runId]: { ...progress, agents } };
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
          setWorkflowProgress(Object.fromEntries(
            hostMessage.messages.flatMap((chatMessage, index) =>
              chatMessage.role === "assistant" && chatMessage.workflow
                ? [[chatMessage.runId ?? `restored-${index}`, chatMessage.workflow]]
                : [],
            ),
          ));
          setAppliedEdits(hostMessage.messages.flatMap((chatMessage) => chatMessage.appliedEdits ?? []));
          setPendingApprovals([]);
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
                    runId: chatMessage.runId ?? `restored-${index}`,
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

  function removeAppliedEdit(notificationId: string) {
    setAppliedEdits((current) => current.filter((notification) => notification.notificationId !== notificationId));
  }

  function dismissAppliedEdit(notificationId: string) {
    removeAppliedEdit(notificationId);
    vscodeApi.postMessage({ type: "editDismissRequested", notificationId });
  }

  function revertEditFile(notificationId: string, path: string) {
    vscodeApi.postMessage({ type: "editRevertRequested", notificationId, paths: [path] });
  }

  function revertAllEditFiles(notificationId: string) {
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
    setWorkflowProgress({});
    setPendingApprovals([]);
    setAppliedEdits([]);
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

  function submitTask(task: string) {
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
        model: runModel,
      });
    } else {
      vscodeApi.postMessage({ type: "startTask", runId, task: trimmedMessage, model: runModel });
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
            <TaskSuggestions onSelect={submitTask} />
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
      </section>

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
      {notification.error ? <div className="edit-approval-error">{notification.error}</div> : null}

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

function formatAnswerInline(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function AssistantAnswer({ content }: { content: string }) {
  const lines = content.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let codeLines: string[] = [];
  let inCodeBlock = false;
  let tableRows: string[][] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(<p key={`paragraph-${blocks.length}`}>{formatAnswerInline(paragraph.join(" ").trim())}</p>);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      return;
    }
    const Tag = listType;
    blocks.push(
      <Tag key={`list-${blocks.length}`}>
        {listItems.map((item, index) => <li key={`${item}-${index}`}>{formatAnswerInline(item)}</li>)}
      </Tag>,
    );
    listItems = [];
    listType = null;
  };

  const flushCode = () => {
    blocks.push(
      <pre key={`code-${blocks.length}`} className="assistant-code"><code>{codeLines.join("\n")}</code></pre>,
    );
    codeLines = [];
  };

  const flushTable = () => {
    if (tableRows.length === 0) {
      return;
    }
    const [header, ...rows] = tableRows;
    blocks.push(
      <table key={`table-${blocks.length}`}>
        <thead><tr>{header.map((cell, index) => <th key={`${cell}-${index}`}>{formatAnswerInline(cell)}</th>)}</tr></thead>
        {rows.length > 0 ? (
          <tbody>{rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{formatAnswerInline(cell)}</td>)}</tr>
          ))}</tbody>
        ) : null}
      </table>,
    );
    tableRows = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      flushTable();
      if (inCodeBlock) {
        flushCode();
      }
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }
    if (!trimmed || /^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushTable();
      return;
    }

    const tableRow = trimmed.startsWith("|") && trimmed.endsWith("|")
      ? trimmed.slice(1, -1).split("|").map((cell) => cell.trim())
      : null;
    if (tableRow) {
      flushParagraph();
      flushList();
      if (!tableRow.every((cell) => /^:?-{3,}:?$/.test(cell))) {
        tableRows.push(tableRow);
      }
      return;
    }

    const heading = trimmed.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      const level = Math.min(4, heading[0].match(/^#+/)?.[0].length ?? 3);
      const Tag = (["h1", "h2", "h3", "h4"] as const)[level - 1];
      blocks.push(<Tag key={`heading-${blocks.length}`}>{formatAnswerInline(heading[1])}</Tag>);
      return;
    }

    const unorderedItem = trimmed.match(/^[-*+]\s+(.+)$/);
    const orderedItem = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unorderedItem || orderedItem) {
      flushParagraph();
      flushTable();
      const nextType = unorderedItem ? "ul" : "ol";
      if (listType && listType !== nextType) {
        flushList();
      }
      listType = nextType;
      listItems.push((unorderedItem ?? orderedItem)![1]);
      return;
    }

    flushList();
    flushTable();
    paragraph.push(trimmed);
  });

  flushParagraph();
  flushList();
  flushTable();
  if (inCodeBlock || codeLines.length > 0) {
    flushCode();
  }

  return <>{blocks}</>;
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
              <li
                key={entry.callId}
                className={`tool-call-entry tool-call-${entry.status}`}
                data-call-id={entry.callId}
              >
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

      {workflow?.agents.length || workflow?.step !== undefined ? <WorkflowPlan workflow={workflow} parentStatus={turn.status} /> : null}
      {turn.content.length > 0 ? <div className="message-body assistant-answer"><AssistantAnswer content={turn.content} /></div> : null}
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

function WorkflowPlan({ workflow, parentStatus }: { workflow: WorkflowProgress; parentStatus: AssistantTurn["status"] }) {
  const allChildrenSettled = workflow.agents.every((agent) =>
    ["completed", "failed", "cancelled"].includes(agent.status),
  );
  const summaryStatus: WorkflowPlanStatus =
    parentStatus === "done"
      ? "completed"
      : parentStatus === "error"
        ? "failed"
        : allChildrenSettled
          ? "running"
          : "pending";
  const items: WorkflowPlanItem[] = [
    ...workflow.agents,
    { id: "parent-summary", task: "父智能体汇总结果", dependsOn: workflow.agents.map((agent) => agent.id), status: summaryStatus },
  ];
  const completedCount = items.filter((item) => item.status === "completed").length;

  return (
    <section className="workflow-plan" aria-label="执行计划">
      <div className="workflow-plan-header">
        <strong>执行计划</strong>
        {workflow.phase ? <span className="workflow-plan-phase">{workflow.phase}</span> : null}
        {workflow.step !== undefined ? <span className="workflow-plan-phase">step {workflow.step} · v{workflow.stateVersion ?? 0}</span> : null}
        {workflow.stopReason ? <span className="workflow-plan-phase">{workflow.stopReason}</span> : null}
        <span className="workflow-plan-count">{completedCount} / {items.length}</span>
      </div>
      <ol className="workflow-plan-list">
        {items.map((item) => (
          <li
            key={item.id}
            className={`workflow-plan-item workflow-plan-${item.status}`}
            data-agent-id={item.id === "parent-summary" ? undefined : item.id}
            data-status={item.status}
            title={item.dependsOn.length > 0 ? `依赖: ${item.dependsOn.join(", ")}` : undefined}
          >
            <span className="workflow-plan-icon" aria-hidden="true">{formatWorkflowStatusIcon(item.status)}</span>
            <span className="workflow-plan-copy">
              <span className="workflow-plan-task">{item.task}</span>
              <span className="workflow-plan-meta">
                {item.role ? `${item.role} · ` : ""}{formatWorkflowStatus(item.status)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatWorkflowStatus(status: WorkflowPlanStatus): string {
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "等待中";
}

function formatWorkflowStatusIcon(status: WorkflowPlanStatus): string {
  if (status === "running") return "●";
  if (status === "completed") return "✓";
  if (status === "failed" || status === "cancelled") return "×";
  return "○";
}

function attachRunToUserTurn(
  turns: ChatTurn[],
  runId: string,
  task: string,
  createTurnId: (prefix: string) => string,
): ChatTurn[] {
  const attachedUserIndex = findLastIndex(
    turns,
    (turn): turn is UserTurn => turn.role === "user" && turn.runId === runId,
  );
  const userIndex =
    attachedUserIndex !== -1
      ? attachedUserIndex
      : findLastIndex(
          turns,
          (turn): turn is UserTurn => turn.role === "user" && turn.pending === true && turn.content === task,
        );

  if (userIndex === -1) {
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
    if (index !== userIndex || turn.role !== "user") {
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

// ---------------------------------------------------------------------------
// 代码审查报告 UI 组件
// ---------------------------------------------------------------------------

/** 严重级别对应的显示配置 */
const SEVERITY_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  error: { label: "错误", color: "#e53935", icon: "✕" },
  warning: { label: "警告", color: "#fb8c00", icon: "⚠" },
  info: { label: "信息", color: "#1e88e5", icon: "ℹ" },
};

/** 类别对应的中文标签 */
const CATEGORY_LABELS: Record<string, string> = {
  bug: "潜在缺陷",
  style: "代码风格",
  performance: "性能问题",
  security: "安全隐患",
  maintainability: "可维护性",
};

/** 严重级别排序权重 */
const SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function CodeReviewReportView({ report }: { report: CodeReviewReport }) {
  const [expandedSeverity, setExpandedSeverity] = React.useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = React.useState<Set<string>>(new Set());

  // 按严重级别分组
  const groupedBySeverity = React.useMemo(() => {
    const groups: Record<string, CodeReviewIssue[]> = { error: [], warning: [], info: [] };
    for (const issue of report.issues) {
      const group = groups[issue.severity];
      if (group) {
        group.push(issue);
      }
    }
    return groups;
  }, [report.issues]);

  const toggleSeverity = (severity: string) => {
    setExpandedSeverity((prev) => (prev === severity ? null : severity));
  };

  const toggleCategory = (key: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // 默认展开 error 级别
  React.useEffect(() => {
    if (report.issues.some((i) => i.severity === "error") && expandedSeverity === null) {
      setExpandedSeverity("error");
    }
  }, [report.issues, expandedSeverity]);

  const orderedSeverities = Object.keys(groupedBySeverity).sort(
    (a, b) => (SEVERITY_ORDER[a] ?? 99) - (SEVERITY_ORDER[b] ?? 99),
  );

  return (
    <section className="code-review-report" aria-label="代码审查报告">
      <div className="code-review-header">
        <strong>代码审查报告</strong>
        <span className="code-review-target">{report.targetPath}</span>
        <span className="code-review-count">
          共 {report.totalIssues} 个问题
        </span>
        <span className="code-review-time">
          {new Date(report.timestamp).toLocaleString("zh-CN")}
        </span>
      </div>

      <div className="code-review-summary">
        {Object.entries(report.issuesBySeverity).map(([severity, count]) => {
          const config = SEVERITY_CONFIG[severity];
          if (!config || count === 0) return null;
          return (
            <span
              key={severity}
              className="code-review-summary-item"
              style={{ borderColor: config.color }}
            >
              <span style={{ color: config.color }}>{config.icon}</span>
              <span>{config.label}: {count}</span>
            </span>
          );
        })}
        {Object.entries(report.issuesByCategory).length > 0 && (
          <>
            <span className="code-review-summary-divider" aria-hidden="true" />
            {Object.entries(report.issuesByCategory).map(([category, count]) => {
              const label = CATEGORY_LABELS[category] ?? category;
              return (
                <span key={category} className="code-review-summary-item">
                  {label}: {count}
                </span>
              );
            })}
          </>
        )}
      </div>

      {orderedSeverities.map((severity) => {
        const issues = groupedBySeverity[severity];
        if (!issues || issues.length === 0) return null;
        const config = SEVERITY_CONFIG[severity] ?? { label: severity, color: "#999", icon: "?" };
        const isExpanded = expandedSeverity === severity;

        // 在该严重级别内按类别分组
        const byCategory: Record<string, CodeReviewIssue[]> = {};
        for (const issue of issues) {
          const cat = issue.category;
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(issue);
        }
        const sortedCategories = Object.keys(byCategory).sort();

        return (
          <details
            key={severity}
            className={`code-review-severity-group code-review-severity-${severity}`}
            open={isExpanded}
          >
            <summary
              className="code-review-severity-header"
              onClick={() => toggleSeverity(severity)}
              style={{ borderLeftColor: config.color }}
            >
              <span className="code-review-severity-icon" style={{ color: config.color }}>
                {config.icon}
              </span>
              <span className="code-review-severity-label">{config.label}</span>
              <span className="code-review-severity-count">{issues.length} 个</span>
            </summary>

            <div className="code-review-severity-content">
              {sortedCategories.map((category) => {
                const categoryIssues = byCategory[category];
                const catLabel = CATEGORY_LABELS[category] ?? category;
                const catKey = `${severity}-${category}`;
                const isCatExpanded = expandedCategories.has(catKey);

                return (
                  <details
                    key={category}
                    className="code-review-category-group"
                    open={isCatExpanded}
                  >
                    <summary
                      className="code-review-category-header"
                      onClick={() => toggleCategory(catKey)}
                    >
                      <span className="code-review-category-label">{catLabel}</span>
                      <span className="code-review-category-count">{categoryIssues.length} 个</span>
                    </summary>

                    <ul className="code-review-issue-list">
                      {categoryIssues.map((issue, index) => (
                        <li key={`${issue.filePath}-${issue.line}-${index}`} className="code-review-issue-item">
                          <div className="code-review-issue-location">
                            <span className="code-review-issue-file">{issue.filePath}</span>
                            <span className="code-review-issue-line">:{issue.line}</span>
                          </div>
                          <p className="code-review-issue-message">{issue.message}</p>
                          {issue.suggestion ? (
                            <p className="code-review-issue-suggestion">
                              <strong>建议: </strong>{issue.suggestion}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          </details>
        );
      })}
    </section>
  );
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
