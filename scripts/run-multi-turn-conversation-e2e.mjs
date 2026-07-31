// 多轮复杂对话 E2E：在真实 VS Code 宿主里连续提交三轮相互依赖的问题，
// 采集每轮的工具调用、运行图并发、回答内容，并评估上下文保持与只读约束。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import {
  connectCdp,
  delay,
  findWebviewTarget,
  findWorkbenchTarget,
  openLoopAgentView,
} from "./cdpClient.mjs";

const require = createRequire(import.meta.url);
const { CONVERSATION_TURNS, evaluateConversation } = require("./multiTurnConversationE2e.js");
const { parseGraphNodes } = require("./codeExplorationE2e.js");

const root = resolve(import.meta.dirname, "..");
const CDP_PORT = 9333;
const TURN_TIMEOUT_MS = 420_000;
const MODEL_LABEL = "DeepSeek v4 Flash";
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "multi-turn-conversation-e2e.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "multi-turn-conversation-e2e.md");
const parseGraphNodesSource = parseGraphNodes.toString();

// CDP 的 awaitPromise 在 Webview 执行上下文变化后会把挂起的 promise 回收，
// 因此所有注入代码保持同步，需要等待的地方一律回到 Node 侧 delay。
const WEBVIEW_DOCUMENT = `const webviewDocument =
  document.getElementById("active-frame")?.contentDocument ?? document;
const webviewWindow = webviewDocument.defaultView;`;

function syncEval(body) {
  return `(() => {
    ${WEBVIEW_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window missing" };
    ${body}
  })()`;
}

// 首轮负责新建会话并锁定模型；后续轮次必须复用同一会话，否则上下文判定失去意义。
async function prepareConversation(session) {
  await session.send("Runtime.enable");

  const started = await session.evaluate(
    syncEval(`
    const newChatButton = [...webviewDocument.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(newChatButton instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "new chat button missing" };
    }
    newChatButton.click();
    return { ok: true };
  `),
  );
  if (!started?.ok) {
    throw new Error(`新建会话失败: ${started?.reason ?? "未知 Webview 状态"}`);
  }
  await delay(500);

  const modelSelector =
    "form.chat-composer .composer-tools .tool-menu-anchor:first-child > button";
  const current = await session.evaluate(
    syncEval(`
    const modelButton = webviewDocument.querySelector(${JSON.stringify(modelSelector)});
    if (!(modelButton instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "model button missing" };
    }
    return { ok: true, label: modelButton.textContent?.trim() ?? "" };
  `),
  );
  if (!current?.ok) {
    throw new Error(`定位模型按钮失败: ${current?.reason ?? "未知 Webview 状态"}`);
  }

  if (current.label !== MODEL_LABEL) {
    const opened = await session.evaluate(
      syncEval(`
      const modelButton = webviewDocument.querySelector(${JSON.stringify(modelSelector)});
      if (!(modelButton instanceof webviewWindow.HTMLButtonElement)) {
        return { ok: false, reason: "model button missing" };
      }
      modelButton.click();
      return { ok: true };
    `),
    );
    if (!opened?.ok) throw new Error(`打开模型菜单失败: ${opened?.reason}`);
    await delay(300);

    const picked = await session.evaluate(
      syncEval(`
      const modelItem = [...webviewDocument.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.getAttribute("aria-label")?.startsWith(${JSON.stringify(MODEL_LABEL)}),
      );
      if (!(modelItem instanceof webviewWindow.HTMLButtonElement)) {
        return { ok: false, reason: "model option missing" };
      }
      modelItem.click();
      return { ok: true };
    `),
    );
    if (!picked?.ok) throw new Error(`选择模型失败: ${picked?.reason}`);
    await delay(300);
  }

  const confirmed = await session.evaluate(
    syncEval(`
    const modelButton = webviewDocument.querySelector(${JSON.stringify(modelSelector)});
    return { ok: true, label: modelButton?.textContent?.trim() ?? "" };
  `),
  );
  if (confirmed?.label !== MODEL_LABEL) {
    throw new Error(`模型未切换到 ${MODEL_LABEL}，当前为 ${confirmed?.label ?? "未知"}`);
  }
  return { model: confirmed.label };
}

async function submitTurn(session, prompt) {
  const payload = JSON.stringify(prompt);

  const filled = await session.evaluate(
    syncEval(`
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
    return { ok: true, length: textarea.value.length };
  `),
  );
  if (!filled?.ok) {
    throw new Error(`填充输入框失败: ${filled?.reason ?? "未知 Webview 状态"}`);
  }
  await delay(400);

  // 每轮重挂一次观察器，运行图节点的状态迁移只能靠 DOM 变化捕获。
  const armed = await session.evaluate(
    syncEval(`
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "submit unavailable (disabled=" + submit?.disabled + ")" };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;

    webviewWindow.__loopAgentTurnWatch?.observer?.disconnect();
    const workflowEvents = [];
    const workflowStates = new Map();
    const recordWorkflow = () => {
      const agents = [
        ...webviewDocument.querySelectorAll(".workflow-plan-item[data-agent-id]"),
      ];
      for (const agent of agents) {
        const agentId = agent.getAttribute("data-agent-id");
        const status = agent.getAttribute("data-status");
        if (!agentId || !status || workflowStates.get(agentId) === status) continue;
        workflowStates.set(agentId, status);
        workflowEvents.push({ agentId, status, at: Date.now() });
      }
    };
    const observer = new webviewWindow.MutationObserver(recordWorkflow);
    observer.observe(webviewDocument.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-status"],
    });
    webviewWindow.__loopAgentTurnWatch = { events: workflowEvents, observer };

    submit.click();
    return { ok: true, assistantTurnCount };
  `),
  );
  if (!armed?.ok) {
    throw new Error(`提交失败: ${armed?.reason ?? "未知 Webview 状态"}`);
  }
  return armed;
}

async function waitForTurn(session, previousTurnCount) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastSnapshot;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const parseGraphNodes = ${parseGraphNodesSource};
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const webviewWindow = webviewDocument.defaultView ?? window;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;
      const turn = turns.at(-1);
      const meta = turn?.querySelector(".message-meta")?.innerText ?? "";
      const toolCalls = [...(turn?.querySelectorAll(".tool-call-entry") ?? [])].map((entry) => ({
        name: entry.querySelector(".tool-call-name")?.textContent?.trim() ?? "",
        input: entry.querySelector(".tool-call-input")?.textContent?.trim() ?? "",
        output: entry.querySelector(".tool-call-output")?.textContent?.trim() ?? "",
        status: [...entry.classList].find((name) => name.startsWith("tool-call-") && name !== "tool-call-entry") ?? "",
      }));
      const graphDefinitions = toolCalls
        .filter((call) => call.name === "runDynamicGraph")
        .map((call) => parseGraphNodes(call.output))
        .filter(Array.isArray);
      return {
        meta,
        headerStatus:
          webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "",
        reasoning: turn?.querySelector(".reasoning-content")?.innerText ?? "",
        toolCalls,
        graphNodes: graphDefinitions.at(-1) ?? [],
        workflowPlan: turn?.querySelector(".workflow-plan")?.innerText ?? "",
        workflowEvents: webviewWindow.__loopAgentTurnWatch?.events ?? [],
        answer: turn?.querySelector(".assistant-answer")?.innerText ?? "",
        error: turn?.querySelector('[role="alert"]')?.innerText ?? "",
      };
    })()`);

    if (state) {
      lastSnapshot = state;
      if (state.error) return { ...state, done: false };
      if (state.meta.includes("Done") && state.answer.trim()) return { ...state, done: true };
    }
    await delay(1_000);
  }

  const detail = lastSnapshot
    ? ` 最后状态: meta=${JSON.stringify(lastSnapshot.meta)} answerLen=${lastSnapshot.answer.length}`
    : "";
  throw new Error(`等待助手回答超时 ${TURN_TIMEOUT_MS}ms。${detail}`);
}

async function captureScreenshot(session) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
  if (typeof screenshot?.data !== "string") {
    throw new Error("截图未返回 PNG 数据");
  }
  writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}

function writeTranscript(turns, evaluation) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const sections = turns.map((turn, index) => {
    const definition = CONVERSATION_TURNS[index];
    const report = evaluation?.turns?.[index];
    return [
      `## 第 ${index + 1} 轮 — ${definition?.id ?? "unknown"}`,
      "",
      `- 意图: ${definition?.intent ?? "-"}`,
      `- 状态: ${turn.done ? "Done" : turn.error ? "Error" : "未完成"}`,
      `- 耗时: ${Math.round((turn.elapsedMs ?? 0) / 1000)}s`,
      `- 工具调用: ${turn.toolCalls.map((call) => call.name).join(", ") || "-"}`,
      `- 图节点: ${JSON.stringify(turn.graphNodes ?? [])}`,
      `- 最大并发只读节点: ${report?.maxConcurrent ?? "-"}`,
      `- 引用路径: ${(report?.citedPaths ?? []).join(", ") || "-"}`,
      `- 思考过程长度: ${turn.reasoning.length}`,
      turn.error ? `- 错误: ${turn.error}` : "",
      "",
      "### 提问",
      "",
      definition?.prompt ?? "",
      "",
      "### 执行计划",
      "",
      "```",
      turn.workflowPlan || "(无)",
      "```",
      "",
      "### 回答",
      "",
      turn.answer || "(空)",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  });

  writeFileSync(
    TRANSCRIPT_PATH,
    [
      "# 多轮对话 E2E 实录",
      "",
      `- 轮次: ${turns.length} / ${CONVERSATION_TURNS.length}`,
      `- 判定: ${evaluation ? (evaluation.passed ? "通过" : "未通过") : "未评估（运行中断）"}`,
      evaluation
        ? `- 全部轮次完成: ${evaluation.completedAllTurns} / 只读约束: ${evaluation.respectedReadOnly} / 上下文延续: ${evaluation.contextRetained} / 图并行: ${evaluation.graphParallelism}`
        : "",
      "",
      ...sections,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    "utf8",
  );
}

async function main() {
  let workbenchSession;
  let webviewSession;
  let settledEvaluation;
  const collected = [];

  try {
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
    await prepareConversation(webviewSession);

    for (const definition of CONVERSATION_TURNS) {
      let submission;
      try {
        submission = await submitTurn(webviewSession, definition.prompt);
      } catch (error) {
        if (!isContextLost(error)) throw error;
        console.error(`[${definition.id}] Webview 上下文丢失，重连后重试`);
        await webviewSession.close();
        const reconnected = await findWebviewTarget(CDP_PORT);
        webviewSession = await connectCdp(reconnected.webSocketDebuggerUrl);
        submission = await submitTurn(webviewSession, definition.prompt);
      }

      const startedAt = Date.now();
      const state = await waitForTurn(webviewSession, submission.assistantTurnCount);
      collected.push({ ...state, elapsedMs: Date.now() - startedAt });
      console.error(
        `[${definition.id}] done=${state.done} ${Math.round((Date.now() - startedAt) / 1000)}s answerLen=${state.answer.length} tools=${state.toolCalls.map((call) => call.name).join(",") || "-"}`,
      );
      if (state.error) break;
      await delay(1_500);
    }

    const evaluation = evaluateConversation(collected);
    await captureScreenshot(workbenchSession);
    writeTranscript(collected, evaluation);
    settledEvaluation = evaluation;

    console.log(
      JSON.stringify(
        {
          passed: evaluation.passed,
          completedAllTurns: evaluation.completedAllTurns,
          respectedReadOnly: evaluation.respectedReadOnly,
          contextRetained: evaluation.contextRetained,
          graphParallelism: evaluation.graphParallelism,
          turns: evaluation.turns,
          carryover: evaluation.carryover,
          screenshotPath: SCREENSHOT_PATH,
          transcriptPath: TRANSCRIPT_PATH,
        },
        null,
        2,
      ),
    );
    if (!evaluation.passed) process.exitCode = 1;
  } finally {
    if (!settledEvaluation && collected.length > 0) {
      try {
        writeTranscript(collected, undefined);
        console.error(`已保存中断前的 ${collected.length} 轮实录: ${TRANSCRIPT_PATH}`);
      } catch (error) {
        console.error(
          `保存实录失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
