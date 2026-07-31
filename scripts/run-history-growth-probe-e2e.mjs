// 历史增长探针：在同一会话内连续跑多轮，隔离「往返次数」与「单次往返耗时」。
//
// 单轮探针（run-latency-probe-e2e.mjs）已证明工具耗时可忽略、时间几乎全在模型往返。
// 但它无法回答：多轮变慢是因为往返次数变多，还是每次往返本身变慢？
// 本探针让三轮的工作量尽量相当（都需读文件、都不开运行图），
// 于是轮次间唯一显著变化的自变量就是累积的对话历史长度。
//
// callId 形如 `${step}-${call}`（reactAgentRunner.ts），DOM 暴露为 data-call-id，
// 据此还原每轮的 step 边界与每次往返的耗时。

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
const MODEL_LABEL = "DeepSeek v4 Flash";
const ARTIFACT_DIR = resolve(import.meta.dirname, "..", ".artifacts");
const REPORT_PATH = resolve(ARTIFACT_DIR, "history-growth-probe-e2e.json");

// 三个问题彼此独立、体量相当，避免「后面的问题更难」污染结论。
const PROMPTS = [
  "动态工作流的节点并发是如何被限制的？给出关键文件与函数级证据。不要开运行图，不要修改代码。",
  "工具调用的结果是如何回填到模型消息里的？给出关键文件与函数级证据。不要开运行图，不要修改代码。",
  "会话检查点是在什么时机保存的？给出关键文件与函数级证据。不要开运行图，不要修改代码。",
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PICK_DOCUMENT = `
  const webviewDocument =
    document.getElementById("active-frame")?.contentDocument ?? document;
  const webviewWindow = webviewDocument.defaultView;
`;

// CDP 的 awaitPromise 在 Webview 执行上下文变化后会回收挂起的 promise，
// 因此注入代码保持同步，需要等待的地方回到 Node 侧 delay。
const syncEval = (session, body) =>
  session.evaluate(`(() => {
    ${PICK_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    ${body}
  })()`);

async function prepareConversation(session) {
  await session.send("Runtime.enable");

  const started = await syncEval(
    session,
    `const newChat = [...webviewDocument.querySelectorAll("button")].find(
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

  const modelSelector =
    "form.chat-composer .composer-tools .tool-menu-anchor:first-child > button";
  const current = await syncEval(
    session,
    `const button = webviewDocument.querySelector(${JSON.stringify(modelSelector)});
    if (!(button instanceof webviewWindow.HTMLButtonElement)) {
      return { ok: false, reason: "模型按钮缺失" };
    }
    return { ok: true, label: button.textContent?.trim() ?? "" };`,
  );
  if (!current?.ok) throw new Error(`定位模型按钮失败: ${current?.reason}`);

  if (current.label !== MODEL_LABEL) {
    const opened = await syncEval(
      session,
      `const button = webviewDocument.querySelector(${JSON.stringify(modelSelector)});
      if (!(button instanceof webviewWindow.HTMLButtonElement)) {
        return { ok: false, reason: "模型按钮缺失" };
      }
      button.click();
      return { ok: true };`,
    );
    if (!opened?.ok) throw new Error(`打开模型菜单失败: ${opened?.reason}`);
    await delay(300);

    const picked = await syncEval(
      session,
      `const item = [...webviewDocument.querySelectorAll('[role="menuitem"]')].find(
        (entry) => entry.getAttribute("aria-label")?.startsWith(${JSON.stringify(MODEL_LABEL)}),
      );
      if (!(item instanceof webviewWindow.HTMLButtonElement)) {
        return { ok: false, reason: "模型选项缺失" };
      }
      item.click();
      return { ok: true };`,
    );
    if (!picked?.ok) throw new Error(`选择模型失败: ${picked?.reason}`);
    await delay(300);
  }

  const confirmed = await syncEval(
    session,
    `const button = webviewDocument.querySelector(${JSON.stringify(modelSelector)});
    return { ok: true, label: button?.textContent?.trim() ?? "" };`,
  );
  if (confirmed?.label !== MODEL_LABEL) {
    throw new Error(`模型未切到 ${MODEL_LABEL}，当前为 ${confirmed?.label ?? "未知"}`);
  }
}

async function submit(session, prompt) {
  const payload = JSON.stringify(prompt);

  const filled = await syncEval(
    session,
    `const textarea = webviewDocument.querySelector("#message-input");
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
  await delay(300);

  const clicked = await syncEval(
    session,
    `const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "提交按钮不可用 (disabled=" + submit?.disabled + ")" };
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
          inputPreview: (entry.querySelector(".tool-call-input")?.textContent ?? "").slice(0, 160),
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
            inputPreview: call.inputPreview,
            appearedAt: at,
            finishedAt: call.status === "tool-call-running" ? undefined : at,
            status: call.status,
            outputLength: call.outputLength,
          });
          continue;
        }
        existing.status = call.status;
        existing.outputLength = call.outputLength;
        if (!existing.inputPreview) existing.inputPreview = call.inputPreview;
        if (existing.finishedAt === undefined && call.status !== "tool-call-running") {
          existing.finishedAt = at;
        }
      }

      if (snapshot.answerLength > 0 && answerFirstSeenAt === undefined) {
        answerFirstSeenAt = at;
      }
      answerLength = snapshot.answerLength;

      if (snapshot.error) throw new Error(`运行失败: ${snapshot.error}`);
      if (snapshot.meta.includes("Done") && snapshot.answerLength > 0) {
        doneAt = at;
        break;
      }
    }

    await delay(POLL_INTERVAL_MS);
  }

  if (doneAt === undefined) throw new Error(`等待超时 ${TURN_TIMEOUT_MS}ms`);

  return { submittedAt, doneAt, answerFirstSeenAt, answerLength, calls: [...calls.values()] };
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
      inputs: bucket.calls.map((call) => call.inputPreview),
      batched: bucket.calls.length > 1,
      modelMs,
      toolMs,
      totalOutputChars: bucket.calls.reduce((sum, call) => sum + call.outputLength, 0),
    };
  });

  const finalAnswerMs = (answerFirstSeenAt ?? doneAt) - cursor;
  const totalMs = doneAt - submittedAt;
  const roundTripMs = [...breakdown.map((entry) => entry.modelMs), finalAnswerMs];
  const toolMs = breakdown.reduce((sum, entry) => sum + entry.toolMs, 0);
  const modelMs = roundTripMs.reduce((sum, ms) => sum + ms, 0);

  return {
    totalMs,
    roundTrips: roundTripMs.length,
    modelMs,
    toolMs,
    avgRoundTripMs: Math.round(modelMs / roundTripMs.length),
    // 末次往返要生成完整答案，通常显著长于中间往返，单列出来避免拉高均值。
    avgToolStepRoundTripMs: breakdown.length
      ? Math.round(breakdown.reduce((sum, entry) => sum + entry.modelMs, 0) / breakdown.length)
      : 0,
    finalAnswerMs,
    answerLength,
    breakdown,
  };
}

async function main() {
  let workbenchSession;
  let webviewSession;
  const turns = [];

  try {
    await waitForCdp(CDP_PORT);
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
    await prepareConversation(webviewSession);

    // 累积的历史长度用「此前各轮答案字符数之和」近似，作为自变量的代理指标。
    let priorAnswerChars = 0;

    for (const [index, prompt] of PROMPTS.entries()) {
      const submitted = await submit(webviewSession, prompt);
      const raw = await probeTurn(webviewSession, submitted.assistantTurnCount);
      const report = { turn: index + 1, prompt, priorAnswerChars, ...analyze(raw) };
      turns.push(report);
      priorAnswerChars += report.answerLength;

      console.error(
        `[turn ${report.turn}] total=${Math.round(report.totalMs / 1000)}s ` +
          `roundTrips=${report.roundTrips} avgToolStep=${report.avgToolStepRoundTripMs}ms ` +
          `final=${report.finalAnswerMs}ms priorChars=${report.priorAnswerChars}`,
      );
      await delay(1_500);
    }

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify({ turns }, null, 2), "utf8");
    console.log(JSON.stringify({ turns }, null, 2));
  } finally {
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
