// 共用的 LoopAgent Webview 驱动：新建会话、选模型、提交、等一轮跑完。
// 注入代码一律保持同步：CDP 的 awaitPromise 在 Webview 执行上下文变化后会回收挂起的
// promise（"Promise was collected"），需要等待的地方一律回到 Node 侧 delay。

export const MODEL_LABEL = "DeepSeek v4 Flash";

const PICK_DOCUMENT = `
  const webviewDocument = document.getElementById("active-frame")?.contentDocument ?? document;
  const webviewWindow = webviewDocument.defaultView;
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function syncEval(session, body) {
  return session.evaluate(`(() => { ${PICK_DOCUMENT} ${body} })()`);
}

export async function prepareConversation(session) {
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
    if (button.textContent?.trim() === ${JSON.stringify(MODEL_LABEL)}) return { ok: true, already: true };
    button.click();
    return { ok: true, already: false };`,
  );
  if (!selected?.ok) throw new Error(`模型选择失败: ${selected?.reason}`);
  if (selected.already) return;

  await delay(300);
  const confirmed = await syncEval(
    session,
    `if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const item = [...webviewDocument.querySelectorAll('[role="menuitem"]')].find(
      (entry) => entry.getAttribute("aria-label")?.startsWith(${JSON.stringify(MODEL_LABEL)}),
    );
    if (!(item instanceof webviewWindow.HTMLButtonElement)) return { ok: false, reason: "DeepSeek 选项缺失" };
    item.click();
    return { ok: true };`,
  );
  if (!confirmed?.ok) throw new Error(`模型确认失败: ${confirmed?.reason}`);
  await delay(300);
}

export async function submitPrompt(session, prompt) {
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

export async function waitForTurn(session, previousTurnCount, { timeoutMs = 300_000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      ${PICK_DOCUMENT}
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;
      const turn = turns.at(-1);
      const toolCalls = [...(turn?.querySelectorAll(".tool-call-entry[data-call-id]") ?? [])].map((entry) => ({
        callId: entry.getAttribute("data-call-id") ?? "",
        name: entry.querySelector(".tool-call-name")?.textContent?.trim() ?? "",
        input: entry.querySelector(".tool-call-input")?.textContent?.trim() ?? "",
        status: [...entry.classList].find((cls) => cls.startsWith("tool-call-") && cls !== "tool-call-entry") ?? "",
      }));
      const editCards = [...webviewDocument.querySelectorAll(".edit-approval-card")].map((card) => ({
        title: card.querySelector(".edit-approval-title")?.textContent?.trim() ?? "",
        files: [...card.querySelectorAll(".edit-approval-file-name")].map((n) => n.textContent?.trim() ?? ""),
      }));
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
    await delay(pollMs);
  }
  throw new Error(`等待超时 ${timeoutMs}ms`);
}

/** 新建会话 → 提交一次提问 → 等这一轮跑完 */
export async function runSingleTurn(session, prompt, options) {
  await prepareConversation(session);
  const submitted = await submitPrompt(session, prompt);
  return waitForTurn(session, submitted.assistantTurnCount, options);
}
