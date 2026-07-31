// 真实多文件修改 E2E：让真实模型在真实 VS Code 宿主里通过 applyEdit 跨 5 个文件写代码，
// 而后在 Node 侧核对磁盘上的实际内容（不是只看 UI 上报的"成功"）。
//
// 为避免碰撞当前仓库里大量未提交的改动，任务限定在一个新建的 scratch 目录内，
// 不触碰任何已跟踪文件。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { connectCdp, findWebviewTarget, findWorkbenchTarget, openLoopAgentView, waitForCdp } from "./cdpClient.mjs";

const CDP_PORT = 9333;
const POLL_INTERVAL_MS = 300;
const TURN_TIMEOUT_MS = 300_000;
const ROOT = resolve(import.meta.dirname, "..");
const SCRATCH_DIR = resolve(ROOT, ".e2e-multifile-scratch");
const ARTIFACT_DIR = resolve(ROOT, ".artifacts");
const REPORT_PATH = resolve(ARTIFACT_DIR, "multi-file-edit-e2e.json");

const FILES = [
  { rel: ".e2e-multifile-scratch/add.ts", fn: "add" },
  { rel: ".e2e-multifile-scratch/subtract.ts", fn: "subtract" },
  { rel: ".e2e-multifile-scratch/multiply.ts", fn: "multiply" },
  { rel: ".e2e-multifile-scratch/divide.ts", fn: "divide" },
  { rel: ".e2e-multifile-scratch/index.ts", fn: null },
];

const PROMPT =
  "在工作区新建目录 .e2e-multifile-scratch，创建 5 个 TypeScript 文件：" +
  "add.ts、subtract.ts、multiply.ts、divide.ts 分别导出一个同名函数（add/subtract/multiply/divide），" +
  "每个函数接收两个 number 参数并返回 number；divide 在除数为 0 时必须抛出 Error。" +
  "再创建 index.ts，从这四个文件里 re-export 全部四个函数。" +
  "不要运行任何命令，也不要修改这五个文件之外的任何内容。";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PICK_DOCUMENT = `
  const webviewDocument = document.getElementById("active-frame")?.contentDocument ?? document;
  const webviewWindow = webviewDocument.defaultView;
`;

function syncEval(session, body) {
  return session.evaluate(`(() => { ${PICK_DOCUMENT} ${body} })()`);
}

async function prepareConversation(session) {
  await session.send("Runtime.enable");

  const started = await syncEval(
    session,
    `if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const newChat = [...webviewDocument.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(newChat instanceof webviewWindow.HTMLButtonElement)) return { ok: false, reason: "New chat 按钮缺失" };
    newChat.click();
    return { ok: true };`,
  );
  if (!started?.ok) throw new Error(`新建会话失败: ${started?.reason}`);
  await delay(400);

  const selected = await syncEval(
    session,
    `if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const button = webviewDocument.querySelector(
      "form.chat-composer .composer-tools .tool-menu-anchor:first-child > button",
    );
    if (!(button instanceof webviewWindow.HTMLButtonElement)) return { ok: false, reason: "模型按钮缺失" };
    if (button.textContent?.trim() === "DeepSeek v4 Flash") return { ok: true, already: true };
    button.click();
    return { ok: true, already: false };`,
  );
  if (!selected?.ok) throw new Error(`模型选择失败: ${selected?.reason}`);

  if (!selected.already) {
    await delay(300);
    const confirmed = await syncEval(
      session,
      `if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
      const item = [...webviewDocument.querySelectorAll('[role="menuitem"]')].find(
        (entry) => entry.getAttribute("aria-label")?.startsWith("DeepSeek v4 Flash"),
      );
      if (!(item instanceof webviewWindow.HTMLButtonElement)) return { ok: false, reason: "DeepSeek 选项缺失" };
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
    `if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const textarea = webviewDocument.querySelector("#message-input");
    if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) return { ok: false, reason: "输入框缺失" };
    const setter = Object.getOwnPropertyDescriptor(webviewWindow.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return { ok: false, reason: "输入框 setter 缺失" };
    setter.call(textarea, ${payload});
    textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
    return { ok: true };`,
  );
  if (!filled?.ok) throw new Error(`填入提问失败: ${filled?.reason}`);
  await delay(250);

  const clicked = await syncEval(
    session,
    `if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) return { ok: false, reason: "提交按钮不可用" };
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;
    submit.click();
    return { ok: true, assistantTurnCount };`,
  );
  if (!clicked?.ok) throw new Error(`提交失败: ${clicked?.reason}`);
  return clicked;
}

async function waitForTurn(session, previousTurnCount) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      ${PICK_DOCUMENT}
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;
      const turn = turns.at(-1);
      const toolCalls = [...(turn?.querySelectorAll(".tool-call-entry[data-call-id]") ?? [])].map((entry) => ({
        callId: entry.getAttribute("data-call-id") ?? "",
        name: entry.querySelector(".tool-call-name")?.textContent?.trim() ?? "",
        status: [...entry.classList].find((cls) => cls.startsWith("tool-call-") && cls !== "tool-call-entry") ?? "",
      }));
      const editCards = [...webviewDocument.querySelectorAll(".edit-approval-card")].map(
        (card) => card.querySelector(".edit-approval-title")?.textContent?.trim() ?? "",
      );
      return {
        toolCalls,
        editCards,
        answer: turn?.querySelector(".assistant-answer")?.innerText ?? "",
        meta: turn?.querySelector(".message-meta")?.innerText ?? "",
        error: turn?.querySelector('[role="alert"]')?.innerText ?? "",
      };
    })()`);

    if (state?.error) throw new Error(`运行失败: ${state.error}`);
    if (state?.meta.includes("Done") && state.answer.trim()) return state;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`等待超时 ${TURN_TIMEOUT_MS}ms`);
}

function verifyDisk() {
  return FILES.map(({ rel, fn }) => {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) {
      return { rel, exists: false, exportsExpectedFn: false, size: 0 };
    }
    const content = readFileSync(path, "utf8");
    const exportsExpectedFn = fn
      ? new RegExp(`export\\s+function\\s+${fn}\\b|export\\s+const\\s+${fn}\\b`).test(content)
      : true;
    return { rel, exists: true, exportsExpectedFn, size: content.length };
  });
}

async function main() {
  let workbenchSession;
  let webviewSession;
  try {
    // 先确认 scratch 目录不存在，避免上一次失败运行的残留把这次的"新建成功"判断带偏。
    if (existsSync(SCRATCH_DIR)) {
      rmSync(SCRATCH_DIR, { recursive: true, force: true });
    }

    await waitForCdp(CDP_PORT);
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
    await prepareConversation(webviewSession);

    const submitted = await submit(webviewSession, PROMPT);
    const turn = await waitForTurn(webviewSession, submitted.assistantTurnCount);
    const disk = verifyDisk();

    const report = {
      prompt: PROMPT,
      toolCalls: turn.toolCalls,
      editCardsSeen: turn.editCards.length,
      answerLength: turn.answer.length,
      answer: turn.answer,
      disk,
      allFilesCreated: disk.every((f) => f.exists),
      allExportsPresent: disk.every((f) => f.exportsExpectedFn),
    };

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!report.allFilesCreated || !report.allExportsPresent) process.exitCode = 1;
  } finally {
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
