import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/shared/messages";

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
    expect(screen.getByRole("button", { name: "DeepSeek v4 Flash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Think: Off" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("Start a conversation with LoopAgent.")).toBeInTheDocument();
  });

  it("sends the selected model and thinking mode with the task", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();

    render(<App vscodeApi={{ postMessage }} />);

    await user.click(screen.getByRole("button", { name: "Think: Off" }));
    await user.click(screen.getByRole("menuitem", { name: "On Enables provider reasoning mode" }));
    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "startTask",
      task: "hello",
      model: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinking: "enabled",
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
      model: {
        provider: "fake",
        model: "fake-local",
        thinking: "disabled",
      },
    });
  });

  it("renders assistant process and streamed answer", async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();

    render(<App vscodeApi={{ postMessage }} />);

    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    postHostMessage({ type: "runStarted", runId: "run-1", task: "hello" });
    postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek v4 flash" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Calling DeepSeek v4 flash" });
    postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Received model reasoning signal" });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "Hello! " });
    postHostMessage({ type: "assistantDelta", runId: "run-1", content: "How can I help you today?" });
    postHostMessage({ type: "assistantFinished", runId: "run-1" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("DeepSeek v4 flash")).toBeInTheDocument();
    expect(screen.getByText("Process")).toBeInTheDocument();
    expect(screen.getByText("Calling DeepSeek v4 flash")).toBeInTheDocument();
    expect(screen.getByText("Received model reasoning signal")).toBeInTheDocument();
    expect(screen.getByText("Hello! How can I help you today?")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "again");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
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

  it("keeps legacy agent events visible as process entries", () => {
    render(<App />);

    postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
    postHostMessage({ type: "agentEvent", runId: "run-1", message: "Building context" });
    postHostMessage({ type: "runFinished", runId: "run-1" });

    expect(screen.getByText("Inspect the project")).toBeInTheDocument();
    expect(screen.getByText("Building context")).toBeInTheDocument();
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
  });
});
