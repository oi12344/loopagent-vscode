// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/shared/messages";
import type { ChatMessage } from "../src/shared/chatTypes";

afterEach(cleanup);

function postHostMessage(message: HostToWebviewMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  });
}

describe("LoopAgent webview app", () => {
  it("renders an empty chat composer", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "LoopAgent" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Chat composer" })).toHaveClass("chat-composer");
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DeepSeek v4 Flash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Think: On" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("Start a conversation with LoopAgent.")).toBeInTheDocument();
  });

  it("submits a suggested workspace task", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.click(screen.getByRole("button", { name: "Explain the active file" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "startTask",
      runId: expect.stringMatching(/^run-/),
      task: "Explain the active file",
      model: { provider: "deepseek", model: "deepseek-v4-flash", thinking: "enabled" },
    });
    expect(screen.getByText("Explain the active file")).toBeInTheDocument();
  });

  it("shows one user message when conversationStarted and runStarted share a run", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByRole("textbox"), "Inspect the project");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const startTask = postMessage.mock.calls.at(-1)?.[0];
    expect(startTask?.type).toBe("startTask");
    if (!startTask || startTask.type !== "startTask") throw new Error("startTask was not posted");

    postHostMessage({
      type: "conversationStarted",
      conversationId: "conv-1",
      runId: startTask.runId,
      userMessage: "Inspect the project",
    });
    postHostMessage({ type: "runStarted", runId: startTask.runId, task: "Inspect the project" });

    expect(screen.getAllByText("Inspect the project")).toHaveLength(1);
  });

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

  it("ignores stale streaming messages from a run that was in flight when New chat was clicked", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByRole("textbox"), "Old task");
    await user.click(screen.getByRole("button", { name: "Send" }));

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Old task" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "deepseek" });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "stale content" });
    expect(screen.getByText("stale content")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByText("Start a conversation with LoopAgent.")).toBeInTheDocument();

    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "more stale content" });

    expect(screen.queryByText("stale content", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText("Start a conversation with LoopAgent.")).toBeInTheDocument();
  });

  it("shows a Stop button while a run is active and cancels the run on click", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByRole("textbox"), "Old task");
    await user.click(screen.getByRole("button", { name: "Send" }));

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Old task" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "deepseek" });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "partial content" });

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(postMessage).toHaveBeenCalledWith({ type: "stopRun" });

    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "more content" });

    expect(screen.getByText("partial content")).toBeInTheDocument();
    expect(screen.queryByText("more content", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("offers resume after an interrupted run and starts a new run for the same conversation", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    postHostMessage({ type: "conversationStarted", conversationId: "conv-1", runId: "run-1", userMessage: "Interrupted task" });
    postHostMessage({ type: "runStarted", runId: "run-1", task: "Interrupted task" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "deepseek" });
    postHostMessage({ type: "runInterrupted", runId: "run-1", conversationId: "conv-1", task: "Interrupted task" });

    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "resumeRun",
      runId: expect.stringMatching(/^run-/),
      conversationId: "conv-1",
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("removes an empty assistant placeholder when stopping after assistantFinished", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.type(screen.getByRole("textbox"), "Stop before content");
    await user.click(screen.getByRole("button", { name: "Send" }));
    postHostMessage({ type: "runStarted", runId: "run-1", task: "Stop before content" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "deepseek" });
    postHostMessage({ type: "assistantFinished", runId: "run-1" });

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(container.querySelector(".message-assistant")).toBeNull();
  });

  it("ignores late run messages when stopped before runStarted arrives", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    const { container } = render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByRole("textbox"), "Stop immediately");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const startMessage = postMessage.mock.calls.find(([message]) => message.type === "startTask")?.[0];

    expect(startMessage).toEqual(expect.objectContaining({ runId: expect.stringMatching(/^run-/) }));
    const runId = (startMessage as WebviewToHostMessage & { runId: string }).runId;

    await user.click(screen.getByRole("button", { name: "Stop" }));
    postHostMessage({ type: "runStarted", runId, task: "Stop immediately" });
    postHostMessage({ type: "assistantStarted", runId, provider: "deepseek" });
    postHostMessage({ type: "assistantFinished", runId });
    postHostMessage({ type: "runFinished", runId });

    expect(container.querySelector(".message-assistant")).toBeNull();
  });

  it("sends the selected model and thinking mode with the task", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();

    render(<App vscodeApi={{ postMessage }} />);

    await user.click(screen.getByRole("button", { name: "Think: On" }));
    await user.click(screen.getByRole("menuitem", { name: "Off Uses direct answer mode" }));
    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "startTask",
      runId: expect.stringMatching(/^run-/),
      task: "hello",
      model: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinking: "disabled",
      },
    });
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("sends typed tasks without a task mode", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByLabelText("Message"), "Explain this function");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "startTask", task: "Explain this function" }),
    );
    expect(postMessage.mock.calls.at(-1)?.[0]).not.toHaveProperty("mode");
  });

  it("shows workflow and subagent progress without replacing the assistant answer", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "LoopAgent" });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "Existing answer" });
    postHostMessage({ type: "workflowStateChanged", runId: "run-1", phase: "implement" });
    postHostMessage({ type: "subagentStateChanged", runId: "run-1", agentId: "implementer-1", status: "running" });

    expect(screen.getByText("Existing answer")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText("implementer-1")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
  });

  it("renders every graph node and the parent summary inside the assistant message", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "LoopAgent" });
    postHostMessage({
      type: "subagentPlanCreated",
      runId: "run-1",
      agentId: "subagent-1",
      task: "分析 Webview 到扩展宿主的调用链",
      role: "explorer",
      dependsOn: [],
    });
    postHostMessage({
      type: "subagentPlanCreated",
      runId: "run-1",
      agentId: "subagent-2",
      task: "分析扩展宿主到 DeepSeek 的调用链",
      role: "explorer",
      dependsOn: [],
    });

    expect(screen.getByRole("region", { name: "执行计划" })).toBeInTheDocument();
    expect(screen.getByText("分析 Webview 到扩展宿主的调用链")).toBeInTheDocument();
    expect(screen.getByText("分析扩展宿主到 DeepSeek 的调用链")).toBeInTheDocument();
    expect(screen.getByText("父智能体汇总结果")).toBeInTheDocument();
    expect(screen.getByText("0 / 3")).toBeInTheDocument();

    postHostMessage({ type: "subagentStateChanged", runId: "run-1", agentId: "subagent-1", status: "completed" });
    postHostMessage({ type: "subagentStateChanged", runId: "run-1", agentId: "subagent-2", status: "completed" });
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    postHostMessage({ type: "assistantFinished", runId: "run-1" });
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
  });

  it("renders live process evidence under the matching graph node", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "LoopAgent" });
    postHostMessage({
      type: "workflowNodeEvent",
      runId: "run-1",
      agentId: "subagent-1",
      event: "thinking",
      content: "starting",
    });
    postHostMessage({
      type: "subagentPlanCreated",
      runId: "run-1",
      agentId: "subagent-1",
      task: "运行验证",
      role: "executor",
      dependsOn: [],
    });
    postHostMessage({ type: "toolCallStarted", runId: "run-1", callId: "call-1", toolName: "runCommand", input: "npm test" });
    postHostMessage({
      type: "workflowNodeEvent",
      runId: "run-1",
      agentId: "subagent-1",
      event: "tool_started",
      content: "npm test",
      callId: "call-1",
      toolName: "runCommand",
      input: "npm test",
    });
    postHostMessage({
      type: "workflowNodeEvent",
      runId: "run-1",
      agentId: "subagent-1",
      event: "tool_finished",
      content: "passed",
      callId: "call-1",
      succeeded: true,
      output: "passed",
    });
    postHostMessage({ type: "toolCallFinished", runId: "run-1", callId: "call-1", succeeded: true, output: "passed" });
    postHostMessage({
      type: "workflowNodeEvent",
      runId: "run-1",
      agentId: "subagent-1",
      event: "tool_finished",
      content: "boom",
      callId: "call-2",
      succeeded: false,
    });

    const process = document.querySelector(".process-details");
    const tool = document.querySelector('[data-call-id="call-1"]');
    expect(process).toHaveAttribute("data-process-state", "running");
    expect(document.querySelectorAll('[data-call-id="call-1"]')).toHaveLength(1);
    expect(tool?.textContent).toContain("npm test");
    expect(tool?.textContent).toContain("passed");

    const plan = screen.getByRole("region", { name: "执行计划" });
    expect(plan.querySelector(".workflow-node-process")).toBeInTheDocument();
    expect(plan).not.toHaveTextContent("passed");
    expect(plan).not.toHaveTextContent("boom");
    expect(screen.getByText("运行验证").closest("li")).toHaveAttribute("data-agent-id", "subagent-1");
  });

  it("bounds the number of restored messages rendered in the chat log", () => {
    render(<App />);

    const messages: ChatMessage[] = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `restored-${index}`,
      runId: `run-${index}`,
    }));

    postHostMessage({ type: "conversationRestored", conversationId: "conv-large", messages });

    expect(screen.getByText("restored-119")).toBeInTheDocument();
    expect(screen.queryByText("restored-0")).not.toBeInTheDocument();
    expect(screen.getByText(/earlier messages hidden/i)).toBeInTheDocument();
  });

  it("bounds the rendered process steps while keeping the total count", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-large", provider: "LoopAgent" });
    for (let index = 0; index < 80; index += 1) {
      postHostMessage({
        type: "toolCallStarted",
        runId: "run-large",
        callId: `call-${index}`,
        toolName: "runCommand",
        input: `echo ${index}`,
      });
    }

    expect(screen.getByText("80 steps")).toBeInTheDocument();
    expect(screen.queryByText("echo 0")).not.toBeInTheDocument();
    expect(screen.getByText("echo 79")).toBeInTheDocument();
  });

  it("marks the parent workflow summary cancelled when the run is interrupted", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "LoopAgent" });
    postHostMessage({
      type: "subagentPlanCreated",
      runId: "run-1",
      agentId: "subagent-1",
      task: "运行验证",
      role: "executor",
      dependsOn: [],
    });
    postHostMessage({ type: "workflowStateChanged", runId: "run-1", phase: "failed" });
    postHostMessage({
      type: "runInterrupted",
      runId: "run-1",
      conversationId: "conversation-1",
      task: "运行验证",
    });

    const parent = document.querySelector('.workflow-plan-item:not([data-agent-id])');
    expect(parent).toHaveAttribute("data-status", "cancelled");
    expect(parent).toHaveTextContent("已取消");
  });

  it("shows dynamic subagent progress before a workflow phase is reported", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "LoopAgent" });
    postHostMessage({ type: "subagentStateChanged", runId: "run-1", agentId: "explorer-1", status: "running" });

    expect(screen.getByRole("region", { name: "执行计划" })).toBeInTheDocument();
    expect(screen.getByText("explorer-1")).toBeInTheDocument();
  });

  it("renders assistant process and streamed answer", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();

    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    postHostMessage({ type: "runStarted", runId: "run-1", task: "hello" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek v4 flash" });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Inspecting the request. " });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Preparing the answer." });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "Hello! " });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "How can I help you today?" });
    postHostMessage({ type: "assistantFinished", runId: "run-1" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("DeepSeek v4 flash")).toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("Inspecting the request. Preparing the answer.")).toBeInTheDocument();
    expect(screen.queryByText("Calling DeepSeek v4 flash")).not.toBeInTheDocument();
    expect(screen.queryByText("Received model reasoning signal")).not.toBeInTheDocument();
    expect(screen.getByText("Hello! How can I help you today?")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "again");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("renders a live process timeline for thinking, workflow, and tools", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Planning the next step" });
    postHostMessage({ type: "workflowStateChanged", runId: "run-1", phase: "executing" });
    postHostMessage({ type: "toolCallStarted", runId: "run-1", callId: "call-1", toolName: "exploreCode", input: "src/extension" });

    const process = document.querySelector(".process-details");
    expect(process).toHaveAttribute("data-process-state", "running");
    expect(process).toHaveAttribute("open");
    expect(screen.getByText("Planning the next step")).toBeInTheDocument();
    expect(screen.getAllByText("exploreCode")).not.toHaveLength(0);
    expect(document.querySelectorAll(".process-timeline-step").length).toBeGreaterThanOrEqual(2);

    postHostMessage({ type: "toolCallFinished", runId: "run-1", callId: "call-1", succeeded: true, output: "found files" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(process).toHaveAttribute("data-process-state", "completed");
    expect(process).not.toHaveAttribute("open");
  });

  it("reopens process context when a finished run becomes interrupted", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Waiting for recovery" });
    postHostMessage({ type: "assistantFinished", runId: "run-1" });
    postHostMessage({ type: "runInterrupted", runId: "run-1", conversationId: "conversation-1", task: "Inspect the project" });

    const process = document.querySelector(".process-details");
    expect(process).toHaveAttribute("data-process-state", "interrupted");
    expect(process).toHaveAttribute("open");
  });

  it("renders assistant markdown as formatted content without control symbols", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({
      type: "assistantDelta",
      runId: "run-1",
      content: "## Summary\n\n### Key path\n- First item\n- **Second item**\n\n```ts\nconst result = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| Result | `1` |\n\n---",
    });
    postHostMessage({ type: "assistantFinished", runId: "run-1" });

    const answer = document.querySelector(".assistant-answer");
    expect(answer).toBeInTheDocument();
    expect(answer).toHaveTextContent("Summary");
    expect(answer).toHaveTextContent("First item");
    expect(answer).toHaveTextContent("Second item");
    expect(answer).toHaveTextContent("const result = 1;");
    expect(answer?.textContent).not.toContain("##");
    expect(answer?.textContent).not.toContain("```");
    expect(answer?.textContent).not.toContain("---");
    expect(answer?.textContent).not.toContain("|");
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("const result = 1;")).toBeInTheDocument();
  });

  it("normalizes escaped markdown line breaks in assistant answers", () => {
    render(<App />);

    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({
      type: "assistantDelta",
      runId: "run-1",
      content: "## Escaped summary\\n\\n- First item",
    });

    const answer = document.querySelector(".assistant-answer");
    expect(screen.getByRole("heading", { name: "Escaped summary" })).toBeInTheDocument();
    expect(screen.getByText("First item")).toBeInTheDocument();
    expect(answer?.textContent).not.toContain("\\n");
  });

  it("collapses completed execution steps", () => {
    render(<App />);
    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Reading files" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("思考过程").closest("details")).not.toHaveAttribute("open");
  });

  it("shows high-level thinking and provider reasoning in the process timeline", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Building code context" });
    postHostMessage({ type: "agentEvent", runId: "run-1", message: "Running tool exploreCode" });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Inspecting the active file. " });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Checking callers." });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("Inspecting the active file. Checking callers.")).toBeInTheDocument();
    expect(screen.getByText("Building code context")).toBeInTheDocument();
    expect(screen.queryByText("Running tool exploreCode")).not.toBeInTheDocument();
    expect(screen.getByText("Inspect the project").closest("article")).toHaveClass("message-user-right");
    expect(screen.getByText("思考过程").closest("details")).not.toHaveAttribute("open");
  });

  it("preserves provider reasoning newlines", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Inspecting the active file.\nChecking callers." });

    const reasoning = screen.getByText(
      (_, element) => element?.textContent === "Inspecting the active file.\nChecking callers.",
    );
    expect(reasoning.textContent).toBe("Inspecting the active file.\nChecking callers.");
  });

  it("renders run failures in the assistant turn", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();

    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    postHostMessage({ type: "runStarted", runId: "run-1", task: "hello" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek v4 flash" });
    postHostMessage({ type: "runFailed", runId: "run-1", message: "Authentication failed" });

    expect(screen.getByText("Authentication failed")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "again");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("renders paired tool input and output in the process timeline order", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Run some commands" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Choose the commands" });
    postHostMessage({ type: "toolCallStarted", runId: "run-1", callId: "1-1", toolName: "runCommand", input: "echo first" });
    postHostMessage({ type: "toolCallStarted", runId: "run-1", callId: "1-2", toolName: "runCommand", input: "echo second" });
    postHostMessage({ type: "toolCallFinished", runId: "run-1", callId: "1-1", succeeded: true, output: "first" });
    postHostMessage({ type: "toolCallFinished", runId: "run-1", callId: "1-2", succeeded: false, output: "boom" });

    const steps = Array.from(document.querySelectorAll(".process-timeline-step"));
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining("Choose the commands"),
      expect.stringContaining("echo first"),
      expect.stringContaining("echo second"),
    ]);
    expect(steps[1]?.textContent).toContain("first");
    expect(steps[2]?.textContent).toContain("boom");
    expect(screen.getByText("echo second")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(document.querySelector(".tool-calls-details")).not.toBeInTheDocument();

    postHostMessage({ type: "runFinished", runId: "run-1" });
    expect(document.querySelector(".process-details")).not.toHaveAttribute("open");
  });

  it("renders plan-generation evidence and collapsible tool input/output", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-plan-evidence", task: "生成计划" });
    postHostMessage({ type: "assistantStarted", runId: "run-plan-evidence", provider: "DeepSeek" });
    postHostMessage({ type: "assistantThinking", runId: "run-plan-evidence", message: "生成工作流计划" });
    postHostMessage({ type: "assistantThinking", runId: "run-plan-evidence", message: "已收到候选计划，开始解析和校验" });
    postHostMessage({ type: "assistantThinking", runId: "run-plan-evidence", message: "计划校验通过：1 个节点，依赖关系有效" });
    postHostMessage({ type: "toolCallStarted", runId: "run-plan-evidence", callId: "call-1", toolName: "runCommand", input: "npm test" });
    postHostMessage({ type: "toolCallFinished", runId: "run-plan-evidence", callId: "call-1", succeeded: true, output: "passed" });

    expect(screen.getByText("生成工作流计划")).toBeInTheDocument();
    expect(screen.getByText("已收到候选计划，开始解析和校验")).toBeInTheDocument();
    expect(screen.getByText("计划校验通过：1 个节点，依赖关系有效")).toBeInTheDocument();

    const tool = document.querySelector('[data-call-id="call-1"]');
    expect(tool).toBeInTheDocument();
    const inputDetails = tool?.querySelector('details[data-field="input"]');
    const outputDetails = tool?.querySelector('details[data-field="output"]');
    expect(tool?.querySelectorAll("details")).toHaveLength(2);
    expect(inputDetails).toHaveTextContent("Input");
    expect(outputDetails).toHaveTextContent("Output");
    expect(inputDetails).not.toHaveAttribute("open");
    expect(outputDetails).not.toHaveAttribute("open");

    fireEvent.click(inputDetails?.querySelector("summary") as HTMLElement);
    expect(inputDetails).toHaveAttribute("open");
    expect(outputDetails).not.toHaveAttribute("open");

    fireEvent.click(outputDetails?.querySelector("summary") as HTMLElement);
    expect(inputDetails).toHaveAttribute("open");
    expect(outputDetails).toHaveAttribute("open");
  });

  it("does not render legacy agent events as Process", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "agentEvent", runId: "run-1", message: "Building context" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("Inspect the project")).toBeInTheDocument();
    expect(screen.queryByText("Building context")).not.toBeInTheDocument();
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
  });

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

  it("shows an empty state in the History menu when there are no past conversations", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getByText("No past conversations yet.")).toBeInTheDocument();
  });

  it("populates the History menu from a conversationList host message and switches on click", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    postHostMessage({
      type: "conversationList",
      conversations: [
        { conversationId: "conv-1", updatedAt: 2, preview: "And Rust?" },
        { conversationId: "conv-2", updatedAt: 1, preview: "What is TypeScript?" },
      ],
    });

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getByRole("menu", { name: "History" })).toHaveClass("history-menu");
    expect(screen.getByRole("menuitem", { name: "And Rust?" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "What is TypeScript?" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "And Rust?" }));

    expect(postMessage).toHaveBeenCalledWith({ type: "switchConversation", conversationId: "conv-1" });
  });

  it("shows an applied-edit card and filters its file list by search query", async () => {
    const user = userEvent.setup();
    render(<App />);

    postHostMessage({
      type: "editApplied",
      notificationId: "notification-1",
      files: ["src/first.ts", "src/second.ts", "test/first.test.ts"],
      fileStats: [],
    });

    expect(screen.getByRole("button", { name: "src/first.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src/second.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "test/first.test.ts" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search changed files"), "second");

    expect(screen.queryByRole("button", { name: "src/first.ts" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src/second.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "test/first.test.ts" })).not.toBeInTheDocument();
  });

  it("opens a file's diff preview when clicked in the applied-edit list", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    postHostMessage({
      type: "editApplied",
      notificationId: "notification-1",
      files: ["src/first.ts"],
      fileStats: [],
    });

    await user.click(screen.getByRole("button", { name: "src/first.ts" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "editFileOpened",
      notificationId: "notification-1",
      path: "src/first.ts",
    });
  });

  it("dismisses the applied-edit card on 保留 without reverting anything", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    postHostMessage({
      type: "editApplied",
      notificationId: "notification-1",
      files: ["src/first.ts"],
      fileStats: [{ path: "src/first.ts", added: 3, removed: 1 }],
    });

    await user.click(screen.getByRole("button", { name: "保留" }));

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editRevertRequested" }));
    expect(screen.queryByRole("button", { name: "src/first.ts" })).not.toBeInTheDocument();
  });

  it("reverts all files when clicking 撤销 in the applied-edit card", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    postHostMessage({
      type: "editApplied",
      notificationId: "notification-1",
      files: ["src/first.ts"],
      fileStats: [{ path: "src/first.ts", added: 3, removed: 1 }],
    });

    await user.click(screen.getByRole("button", { name: "撤销" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "editRevertRequested",
      notificationId: "notification-1",
      paths: [],
    });
    expect(screen.queryByRole("button", { name: "src/first.ts" })).not.toBeInTheDocument();
  });

  it("reverts a single file when clicking its own revert button", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    postHostMessage({
      type: "editApplied",
      notificationId: "notification-1",
      files: ["src/first.ts", "src/second.ts"],
      fileStats: [],
    });

    await user.click(screen.getByRole("button", { name: "Revert src/first.ts" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "editRevertRequested",
      notificationId: "notification-1",
      paths: ["src/first.ts"],
    });
    expect(screen.queryByRole("button", { name: "src/first.ts" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src/second.ts" })).toBeInTheDocument();
  });
});
