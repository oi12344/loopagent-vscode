import * as React from "react";
import type { HostToWebviewMessage, ModelThinkingMode, RunModelSelection, TaskMode } from "../shared/messages";
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

type AssistantTurn = {
  id: string;
  role: "assistant";
  runId: string;
  provider: string;
  reasoning: string;
  content: string;
  status: "thinking" | "streaming" | "done" | "error";
  error?: string;
};

type ChatTurn = UserTurn | AssistantTurn;

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
  {
    id: "fake-local",
    label: "Fake local",
    description: "Local development runner",
    selection: {
      provider: "fake",
      model: "fake-local",
      thinking: "disabled",
    },
    supportsThinking: false,
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
  const [openMenu, setOpenMenu] = React.useState<"model" | "thinking" | null>(null);
  const [conversationId, setConversationId] = React.useState<string | undefined>(undefined);
  const nextTurnId = React.useRef(0);
  const composerToolsRef = React.useRef<HTMLDivElement | null>(null);

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
      if (composerToolsRef.current && !composerToolsRef.current.contains(event.target as Node)) {
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

  function submitTask(task: string, mode: TaskMode = taskMode) {
    const trimmedMessage = task.trim();

    if (!trimmedMessage || isRunning) {
      return;
    }

    const runModel: RunModelSelection = {
      ...selectedModel.selection,
      thinking: effectiveThinkingMode,
    };

    setIsRunning(true);
    setOpenMenu(null);
    setTurns((currentTurns) => [
      ...currentTurns,
      {
        id: createTurnId("user"),
        role: "user",
        content: trimmedMessage,
        pending: true,
      },
    ]);
    setMessage("");

    if (conversationId) {
      vscodeApi.postMessage({
        type: "continueConversation",
        conversationId,
        userMessage: trimmedMessage,
        mode,
        model: runModel,
      });
    } else {
      vscodeApi.postMessage({ type: "startTask", task: trimmedMessage, mode, model: runModel });
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

            return <AssistantMessage key={turn.id} turn={turn} />;
          })
        )}
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

          <button type="submit" disabled={!message.trim() || isRunning}>
            {isRunning ? "Sending..." : "Send"}
          </button>
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

function UserMessage({ turn }: { turn: UserTurn }) {
  return (
    <article className="message message-user message-user-right">
      <div className="message-meta">You</div>
      <div className="message-body">{turn.content}</div>
    </article>
  );
}

function AssistantMessage({ turn }: { turn: AssistantTurn }) {
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

      {turn.content.length > 0 ? <div className="message-body assistant-answer">{turn.content}</div> : null}
      {turn.status !== "done" && turn.content.length === 0 && !turn.error ? (
        <div className="assistant-placeholder">Waiting for response...</div>
      ) : null}
      {turn.error ? (
        <p className="error-message" role="alert">
          {turn.error}
        </p>
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

  return "Thinking";
}
