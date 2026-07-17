// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/shared/messages";

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
    expect(screen.getByRole("group", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
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
      task: "Explain the active file",
      mode: "ask",
      model: { provider: "deepseek", model: "deepseek-v4-flash", thinking: "enabled" },
    });
    expect(screen.getByText("Explain the active file")).toBeInTheDocument();
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
      task: "hello",
      mode: "edit",
      model: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinking: "disabled",
      },
    });
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
  });

  it("disables deep thinking when the selected model does not support it", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();

    render(<App vscodeApi={{ postMessage }} />);

    await user.click(screen.getByRole("button", { name: "DeepSeek v4 Flash" }));
    await user.click(screen.getByRole("menuitem", { name: "Fake local Local development runner" }));

    expect(screen.getByRole("button", { name: "Fake local" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Think: Not supported" })).toBeDisabled();

    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "startTask",
      task: "hello",
      mode: "edit",
      model: {
        provider: "fake",
        model: "fake-local",
        thinking: "disabled",
      },
    });
  });

  it("sends typed tasks in the selected Ask mode", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
    render(<App vscodeApi={{ postMessage }} />);

    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.type(screen.getByLabelText("Message"), "Explain this function");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "startTask", task: "Explain this function", mode: "ask" }),
    );
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

  it("collapses completed execution steps", () => {
    render(<App />);
    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Reading files" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("思考过程").closest("details")).not.toHaveAttribute("open");
  });

  it("shows only provider reasoning in Process and right-aligns user tasks", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Building code context" });
    postHostMessage({ type: "agentEvent", runId: "run-1", message: "Running tool exploreCode" });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Inspecting the active file. " });
    postHostMessage({ type: "assistantReasoningDelta", runId: "run-1", content: "Checking callers." });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("Inspecting the active file. Checking callers.")).toBeInTheDocument();
    expect(screen.queryByText("Building code context")).not.toBeInTheDocument();
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

  it("does not render legacy agent events as Process", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "agentEvent", runId: "run-1", message: "Building context" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("Inspect the project")).toBeInTheDocument();
    expect(screen.queryByText("Building context")).not.toBeInTheDocument();
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
  });
});
