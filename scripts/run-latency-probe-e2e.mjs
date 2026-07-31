// 单轮延迟探针：按 ReAct step 分解一次对话的墙上时钟。
//
// callId 形如 `${step}-${call}`（reactAgentRunner.ts），DOM 上暴露为 data-call-id。
// 以 250ms 轮询记录每个 callId 首次出现/完成的时刻，即可还原：
//   - 模型往返次数（step 数）
//   - 每次往返的思考+生成耗时（上一步工具结束 → 本步首个工具出现）
//   - 每步工具自身耗时（首个工具出现 → 该步全部工具完成）
//   - 最终答案生成耗时（末步工具完成 → 答案首次出现）

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  connectCdp,
  findWebviewTarget,
  findWorkbenchTarget,
  openLoopAgentView,
  waitForCdp,
} from "./cdpClient.mjs";

const CDP_PORT = 9333;
const POLL_INTERVAL_MS = 250;
const TURN_TIMEOUT_MS = 300_000;
const ARTIFACT_DIR = resolve(import.meta.dirname, "..", ".artifacts");
const REPORT_PATH = resolve(ARTIFACT_DIR, "latency-probe-e2e.json");

const PROBE_PROMPT =
  process.argv[2] ??
  "动态工作流的节点并发是如何被限制的？请给出关键文件与函数级证据。不要开运行图，不要修改代码。";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const syncEval = (session, body) => session.evaluate(`(() => { ${body} })()`);

const PICK_DOCUMENT = `
  const webviewDocument =
    document.getElementById("active-frame")?.contentDocument ?? document;
  const webviewWindow = webviewDocument.defaultView;
`;

async function prepareConversation(session) {
  await session.send("Runtime.enable");

  const started = await syncEval(
    session,
    `${PICK_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const newChat = [...webviewDocument.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(newChat instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "New chat 按钮缺失" };
    }
    newChat.click();
    return { ok: true };`,
  );
  if (!started?.ok) throw new Error(`新建会话失败: ${started?.reason}`);
  await delay(400);

  const selected = await syncEval(
    session,
    `${PICK_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const button = webviewDocument.querySelector(
      "form.chat-composer .composer-tools .tool-menu-anchor:first-child > button",
    );
    if (!(button instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "模型按钮缺失" };
    }
    if (button.textContent?.trim() === "DeepSeek v4 Flash") return { ok: true, already: true };
    button.click();
    return { ok: true, already: false };`,
  );
  if (!selected?.ok) throw new Error(`模型选择失败: ${selected?.reason}`);

  if (!selected.already) {
    await delay(300);
    const confirmed = await syncEval(
      session,
      `${PICK_DOCUMENT}
      if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
      const item = [...webviewDocument.querySelectorAll('[role="menuitem"]')].find(
        (entry) => entry.getAttribute("aria-label")?.startsWith("DeepSeek v4 Flash"),
      );
      if (!(item instanceof webviewWindow.HTMLButtonElement)) {
        return { ok: false, reason: "DeepSeek 选项缺失" };
      }
      item.click();
      return { ok: true };`,
    );
    if (!confirmed?.ok) throw new Error(`模型确认失败: ${confirmed?.reason}`);
    await delay(300);
  }
}

async function submit(session, prompt) {
  const payload = JSON.stringify(prompt);

  const filled = await syncEval(
    session,
    `${PICK_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const textarea = webviewDocument.querySelector("#message-input");
    if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) {
      return { ok: false, reason: "输入框缺失" };
    }
    const setter = Object.getOwnPropertyDescriptor(
      webviewWindow.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!setter) return { ok: false, reason: "输入框 setter 缺失" };
    setter.call(textarea, ${payload});
    textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
    return { ok: true };`,
  );
  if (!filled?.ok) throw new Error(`填入提问失败: ${filled?.reason}`);
  await delay(250);

  const clicked = await syncEval(
    session,
    `${PICK_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "提交按钮不可用" };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;
    submit.click();
    return { ok: true, assistantTurnCount };`,
  );
  if (!clicked?.ok) throw new Error(`提交失败: ${clicked?.reason}`);
  return clicked;
}

async function probeTurn(session, previousTurnCount) {
  const submittedAt = Date.now();
  const deadline = submittedAt + TURN_TIMEOUT_MS;
  // callId -> { appearedAt, finishedAt, name, status }
  const calls = new Map();
  let answerFirstSeenAt;
  let answerLength = 0;
  let doneAt;

  while (Date.now() < deadline) {
    const snapshot = await session.evaluate(`(() => {
      ${PICK_DOCUMENT}
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;
      const turn = turns.at(-1);
      return {
        calls: [...(turn?.querySelectorAll(".tool-call-entry[data-call-id]") ?? [])].map((entry) => ({
          callId: entry.getAttribute("data-call-id") ?? "",
          name: entry.querySelector(".tool-call-name")?.textContent?.trim() ?? "",
          status: [...entry.classList].find(
            (cls) => cls.startsWith("tool-call-") && cls !== "tool-call-entry",
          ) ?? "",
          outputLength: (entry.querySelector(".tool-call-output")?.textContent ?? "").length,
        })),
        answerLength: (turn?.querySelector(".assistant-answer")?.innerText ?? "").length,
        meta: turn?.querySelector(".message-meta")?.innerText ?? "",
        error: turn?.querySelector('[role="alert"]')?.innerText ?? "",
      };
    })()`);

    const at = Date.now();
    if (snapshot) {
      for (const call of snapshot.calls) {
        if (!call.callId) continue;
        const existing = calls.get(call.callId);
        if (!existing) {
          calls.set(call.callId, {
            callId: call.callId,
            name: call.name,
            appearedAt: at,
            finishedAt: call.status === "tool-call-running" ? undefined : at,
            status: call.status,
            outputLength: call.outputLength,
          });
          continue;
        }
        existing.status = call.status;
        existing.outputLength = call.outputLength;
        if (existing.finishedAt === undefined && call.status !== "tool-call-running") {
          existing.finishedAt = at;
        }
      }

      // 终答现在是流式累积的：调工具前的开场白也会先让 answerLength > 0，
      // 随后 assistantContentReset 把它清零重新累积。清零后必须重新锚定
      // answerFirstSeenAt，否则会把开场白的时间戳误当成终答开始时间。
      if (snapshot.answerLength === 0) {
        answerFirstSeenAt = undefined;
      } else if (answerFirstSeenAt === undefined) {
        answerFirstSeenAt = at;
      }
      answerLength = snapshot.answerLength;

      if (snapshot.error) {
        throw new Error(`运行失败: ${snapshot.error}`);
      }
      if (snapshot.meta.includes("Done") && snapshot.answerLength > 0) {
        doneAt = at;
        break;
      }
    }

    await delay(POLL_INTERVAL_MS);
  }

  if (doneAt === undefined) {
    throw new Error(`等待超时 ${TURN_TIMEOUT_MS}ms`);
  }

  return {
    submittedAt,
    doneAt,
    answerFirstSeenAt,
    answerLength,
    calls: [...calls.values()],
  };
}

function analyze({ submittedAt, doneAt, answerFirstSeenAt, answerLength, calls }) {
  const steps = new Map();
  for (const call of calls) {
    const step = Number.parseInt(call.callId.split("-")[0] ?? "", 10);
    if (!Number.isFinite(step)) continue;
    const bucket = steps.get(step) ?? { step, calls: [] };
    bucket.calls.push(call);
    steps.set(step, bucket);
  }

  const ordered = [...steps.values()].sort((a, b) => a.step - b.step);
  let cursor = submittedAt;
  const breakdown = ordered.map((bucket) => {
    const appearedAt = Math.min(...bucket.calls.map((call) => call.appearedAt));
    const finishedAt = Math.max(
      ...bucket.calls.map((call) => call.finishedAt ?? call.appearedAt),
    );
    const modelMs = appearedAt - cursor;
    const toolMs = finishedAt - appearedAt;
    cursor = finishedAt;
    return {
      step: bucket.step,
      tools: bucket.calls.map((call) => call.name),
      parallel: bucket.calls.length > 1,
      modelMs,
      toolMs,
      totalOutputChars: bucket.calls.reduce((sum, call) => sum + call.outputLength, 0),
    };
  });

  const finalAnswerMs = (answerFirstSeenAt ?? doneAt) - cursor;
  const totalMs = doneAt - submittedAt;
  const modelMs = breakdown.reduce((sum, entry) => sum + entry.modelMs, 0) + finalAnswerMs;
  const toolMs = breakdown.reduce((sum, entry) => sum + entry.toolMs, 0);

  return {
    totalMs,
    roundTrips: breakdown.length + 1,
    modelMs,
    toolMs,
    modelShare: totalMs > 0 ? Number((modelMs / totalMs).toFixed(3)) : 0,
    toolShare: totalMs > 0 ? Number((toolMs / totalMs).toFixed(3)) : 0,
    finalAnswerMs,
    answerLength,
    breakdown,
  };
}

async function main() {
  let workbenchSession;
  let webviewSession;
  try {
    await waitForCdp(CDP_PORT);
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
    await prepareConversation(webviewSession);

    const submitted = await submit(webviewSession, PROBE_PROMPT);
    const raw = await probeTurn(webviewSession, submitted.assistantTurnCount);
    const report = { prompt: PROBE_PROMPT, ...analyze(raw) };

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
