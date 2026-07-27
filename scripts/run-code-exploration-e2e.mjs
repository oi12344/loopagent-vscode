import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { CODE_EXPLORATION_QUESTION, evaluateCodeExploration } = require(
  "./codeExplorationE2e.js",
);

const root = resolve(import.meta.dirname, "..");
const CDP_PORT = 9333;
const WAIT_TIMEOUT_MS = 300_000;
const TARGET_TIMEOUT_MS = 20_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SCREENSHOT_PATH = resolve(
  root,
  ".artifacts",
  "code-exploration-e2e.png",
);

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function listTargets() {
  const endpoint = `http://127.0.0.1:${CDP_PORT}/json/list`;
  let response;
  try {
    response = await fetch(endpoint, {
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Could not reach VS Code CDP target list at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`CDP target list failed: HTTP ${response.status}`);
  }

  const targets = await response.json();
  if (!Array.isArray(targets)) {
    throw new Error("CDP target list returned a non-array payload");
  }
  return targets;
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      socket.close();
      rejectOpen(
        new Error(`Timed out connecting to CDP WebSocket: ${webSocketDebuggerUrl}`),
      );
    }, CONNECTION_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timeout);

    socket.addEventListener(
      "open",
      () => {
        cleanup();
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        cleanup();
        rejectOpen(
          new Error(`Failed to connect to CDP WebSocket: ${webSocketDebuggerUrl}`),
        );
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      rejectPending(new Error("CDP WebSocket returned invalid JSON"));
      return;
    }

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(
        new Error(
          `CDP ${request.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
        ),
      );
    } else {
      request.resolve(message.result);
    }
  });

  socket.addEventListener("error", () => {
    rejectPending(new Error("CDP WebSocket failed"));
  });
  socket.addEventListener("close", () => {
    closed = true;
    rejectPending(new Error("CDP WebSocket closed"));
  });

  function send(method, params = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        rejectRequest(new Error(`Cannot send ${method}: CDP WebSocket is not open`));
        return;
      }

      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectRequest(
          new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for CDP ${method}`),
        );
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });

      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        rejectRequest(
          new Error(
            `Could not send CDP ${method}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "CDP evaluation failed",
      );
    }
    return response.result?.value;
  }

  function close() {
    rejectPending(new Error("CDP session closed"));
    if (closed || socket.readyState === WebSocket.CLOSED) return Promise.resolve();

    return new Promise((resolveClose) => {
      const timeout = setTimeout(resolveClose, 1_000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolveClose();
        },
        { once: true },
      );
      socket.close();
    });
  }

  return { send, evaluate, close };
}

async function openLoopAgentView(session) {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("Page.bringToFront");
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const opened = await session.evaluate(`(() => {
      const activityEntry = [...document.querySelectorAll("a")].find(
        (element) => element.getAttribute("aria-label") === "LoopAgent",
      );
      if (!(activityEntry instanceof HTMLElement)) return false;
      if (
        activityEntry.parentElement?.getAttribute("aria-selected") !== "true"
      ) {
        activityEntry.click();
      }
      return true;
    })()`);
    if (opened) {
      await delay(2_000);
      return;
    }
    await delay(500);
  }
  throw new Error("LoopAgent activity entry not found within 20s");
}

async function findWebviewTarget() {
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets();
      const candidates = targets.filter((candidate) => {
        const identity = `${candidate.title ?? ""} ${candidate.url ?? ""}`.toLowerCase();
        return (
          candidate.webSocketDebuggerUrl &&
          !identity.includes("workbench.html") &&
          (identity.includes("vscode-webview") || identity.includes("loopagent"))
        );
      });
      candidates.sort((left, right) => {
        const rank = (candidate) => {
          const identity = `${candidate.title ?? ""} ${candidate.url ?? ""}`.toLowerCase();
          return identity.includes("loopagent") ? 0 : 1;
        };
        return rank(left) - rank(right);
      });
      const target = candidates[0];
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`LoopAgent Webview CDP target not found within 20s${detail}`);
}

async function submitQuestion(session, question) {
  await session.send("Runtime.enable");
  const payload = JSON.stringify(question);
  const submitted = await session.evaluate(`(async () => {
    const webviewDocument =
      document.getElementById("active-frame")?.contentDocument ?? document;
    const webviewWindow = webviewDocument.defaultView;
    if (!webviewWindow) {
      return { ok: false, reason: "webview window missing" };
    }
    const newChatButton = [...webviewDocument.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(newChatButton instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "new chat button missing" };
    }
    newChatButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const modelLabel = "DeepSeek v4 Flash";
    const modelButton = webviewDocument.querySelector(
      "form.chat-composer .composer-tools .tool-menu-anchor:first-child > button",
    );
    if (!(modelButton instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "model button missing" };
    }
    if (modelButton.textContent?.trim() !== modelLabel) {
      modelButton.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const modelItem = [...webviewDocument.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.getAttribute("aria-label")?.startsWith(modelLabel),
      );
      if (!(modelItem instanceof webviewWindow.HTMLButtonElement)) {
        return { ok: false, reason: "DeepSeek model option missing" };
      }
      modelItem.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (modelButton.textContent?.trim() !== modelLabel) {
      return { ok: false, reason: "DeepSeek model selection not confirmed" };
    }

    const textarea = webviewDocument.querySelector("#message-input");
    if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) {
      return { ok: false, reason: "textarea missing" };
    }
    const setter = Object.getOwnPropertyDescriptor(
      webviewWindow.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!setter) return { ok: false, reason: "textarea setter missing" };
    setter.call(textarea, ${payload});
    textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const submit = webviewDocument.querySelector(
      'form.chat-composer button[type="submit"]',
    );
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return {
        ok: false,
        reason:
          "submit button unavailable (value=" +
          textarea.value.length +
          ", disabled=" +
          submit?.disabled +
          ")",
      };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(
      ".message-assistant",
    ).length;
    webviewWindow.__loopAgentE2eWorkflow?.observer?.disconnect();
    const workflowEvents = [];
    const workflowStates = new Map();
    const recordWorkflow = () => {
      const agents = [...webviewDocument.querySelectorAll(".workflow-timeline span")].slice(1);
      for (const agent of agents) {
        const match = agent.textContent?.trim().match(/^(.+): (pending|running|completed|failed|cancelled)$/);
        if (!match || workflowStates.get(match[1]) === match[2]) continue;
        workflowStates.set(match[1], match[2]);
        workflowEvents.push({ agentId: match[1], status: match[2], at: Date.now() });
      }
    };
    const observer = new webviewWindow.MutationObserver(recordWorkflow);
    observer.observe(webviewDocument.body, { childList: true, characterData: true, subtree: true });
    webviewWindow.__loopAgentE2eWorkflow = { events: workflowEvents, observer };
    submit.click();
    return { ok: true, assistantTurnCount };
  })()`);

  if (!submitted?.ok) {
    throw new Error(
      `Could not submit code exploration question: ${submitted?.reason ?? "unknown Webview state"}`,
    );
  }
  return submitted;
}

async function waitForAnswer(session, previousTurnCount) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const webviewWindow = webviewDocument.defaultView ?? window;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;
      const turn = turns.at(-1);
      const toolCalls = [...(turn?.querySelectorAll(".tool-call-entry") ?? [])].map((entry) => ({
        name: entry.querySelector(".tool-call-name")?.textContent?.trim() ?? "",
        input: entry.querySelector(".tool-call-input")?.textContent?.trim() ?? "",
        output: entry.querySelector(".tool-call-output")?.textContent?.trim() ?? "",
      }));
      const graphDefinitions = toolCalls
        .filter((call) => call.name === "createDynamicGraph")
        .map((call) => {
          try { return JSON.parse(call.output).nodes; } catch { return undefined; }
        })
        .filter(Array.isArray);
      return {
        process: [
          ...toolCalls.map((call) => [call.name, call.input].filter(Boolean).join(" ")),
          turn?.querySelector(".workflow-timeline")?.innerText ?? "",
          turn?.querySelector(".message-meta")?.innerText ?? "",
        ].filter(Boolean).join("\\n"),
        workflowEvents: webviewWindow.__loopAgentE2eWorkflow?.events ?? [],
        graphNodes: graphDefinitions.length === 1 ? graphDefinitions[0] : [],
        answer: turn?.querySelector(".assistant-answer")?.innerText ?? "",
        error: turn?.querySelector('[role="alert"]')?.innerText ?? "",
      };
    })()`);
    if (state?.error) throw new Error(`LoopAgent run failed: ${state.error}`);
    if (state?.process.includes("Done") && state.answer.trim()) return state;
    await delay(500);
  }

  throw new Error(`Timed out after ${WAIT_TIMEOUT_MS}ms waiting for LoopAgent`);
}

async function captureWorkbenchScreenshot(session) {
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  const screenshot = await session.send("Page.captureScreenshot", {
    format: "png",
  });
  if (typeof screenshot?.data !== "string") {
    throw new Error("Workbench screenshot did not return PNG data");
  }
  writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}

async function main() {
  let workbenchSession;
  let webviewSession;
  try {
    const targets = await listTargets();
    const workbench =
      targets.find(
        (target) =>
          target.webSocketDebuggerUrl &&
          String(target.url).includes("workbench.html"),
      ) ??
      targets.find(
        (target) =>
          target.webSocketDebuggerUrl &&
          String(target.title).toLowerCase().includes("visual studio code"),
      );
    if (!workbench?.webSocketDebuggerUrl) {
      throw new Error("VS Code workbench CDP target not found");
    }

    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);
    const webviewTarget = await findWebviewTarget();
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
    const submission = await submitQuestion(
      webviewSession,
      CODE_EXPLORATION_QUESTION,
    );
    const result = await waitForAnswer(
      webviewSession,
      submission.assistantTurnCount,
    );
    const evaluation = evaluateCodeExploration(result);
    await captureWorkbenchScreenshot(workbenchSession);

    console.log(
      JSON.stringify(
        {
          passed: evaluation.passed,
          matchedAnchors: evaluation.matchedAnchors,
          matchedPaths: evaluation.matchedPaths,
          missingStates: evaluation.missingStates,
          toolCalls: evaluation.toolCalls,
          parallelReadOnlyNodes: evaluation.parallelReadOnlyNodes,
          reviewerCompleted: evaluation.reviewerCompleted,
          answerLength: result.answer.length,
          screenshotPath: SCREENSHOT_PATH,
        },
        null,
        2,
      ),
    );
    if (!evaluation.passed) process.exitCode = 1;
  } finally {
    await Promise.allSettled([
      webviewSession?.close(),
      workbenchSession?.close(),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
