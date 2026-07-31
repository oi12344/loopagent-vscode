import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  connectCdp,
  delay,
  findWebviewTarget,
  findWorkbenchTarget,
  openLoopAgentView,
} from "./cdpClient.mjs";

const root = resolve(import.meta.dirname, "..");
const port = 9333;
const timeoutMs = 180_000;
const artifactPath = resolve(root, ".artifacts", "workflow-recovery-cdp.json");

const cases = [
  {
    name: "invalid-cycle-endpoint",
    prompt: `只调用一次 runDynamicGraph，严格使用下面的 JSON，不要改写字段，不要调用其它工具：
{"initialNodes":[{"id":"only","task":"返回 ok","role":"explorer"}],"cycles":[{"id":"bad","from":"only","to":"missing","exit":{"hardLimit":1}}]}
期望工具直接报告 cycle 端点 missing 未声明。`,
    validate: (text) => text.includes("runDynamicGraph")
      && /(?:Tool error|错误|失败)/i.test(text)
      && /not an initial node|未声明|不是.*节点/i.test(text)
      && !/静默忽略|没有被校验|不符/i.test(text),
  },
  {
    name: "max-nodes-boundary",
    prompt: `只调用一次 runDynamicGraph，严格使用下面的 JSON，不要改写字段，不要调用其它工具：
{"maxNodes":1,"initialNodes":[{"id":"a","task":"返回 a","role":"explorer"},{"id":"b","task":"返回 b","role":"explorer"}]}
期望工具在执行前报告 maximum nodes limit。`,
    expected: /maximum nodes|节点.*上限|超过.*节点/i,
  },
  {
    name: "timeout-retry",
    prompt: `只调用一次 runDynamicGraph，严格使用下面的 JSON，不要改写字段，不要调用其它工具：
{"initialNodes":[{"id":"stable","task":"返回 stable","role":"explorer"},{"id":"flaky","task":"等待并返回 flaky","role":"explorer","timeoutMs":1,"retry":{"maxAttempts":2}}]}
请返回工具的 workflowStatus、failedNodes 和 attempts 相关证据。`,
    expected: /workflowStatus|failed|retry|attempt|超时|timeout/i,
  },
];

function inWebview(body) {
  return `(() => {
    const webviewDocument = document.getElementById("active-frame")?.contentDocument ?? document;
    const webviewWindow = webviewDocument.defaultView ?? window;
    if (!webviewWindow) return { ok: false, reason: "webview window missing" };
    ${body}
  })()`;
}

async function submit(session, prompt) {
  const payload = JSON.stringify(prompt);
  const filled = await session.evaluate(inWebview(`
    const textarea = webviewDocument.querySelector("#message-input");
    if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) return { ok: false, reason: "textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(webviewWindow.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, ${payload});
    textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
    return { ok: true };
  `));
  if (!filled?.ok) throw new Error(`填充输入框失败: ${filled?.reason ?? "unknown"}`);
  await delay(300);
  const submitted = await session.evaluate(inWebview(`
    const button = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(button instanceof webviewWindow.HTMLButtonElement) || button.disabled) return { ok: false, reason: "submit unavailable" };
    const count = webviewDocument.querySelectorAll(".message-assistant").length;
    button.click();
    return { ok: true, count };
  `));
  if (!submitted?.ok) throw new Error(`提交失败: ${submitted?.reason ?? "unknown"}`);
  return submitted.count;
}

async function waitForAssistant(session, previousCount) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const document = globalThis.document.getElementById("active-frame")?.contentDocument ?? globalThis.document;
      const turns = [...document.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousCount}) return null;
      const turn = turns.at(-1);
      return {
        status: document.querySelector(".status-pill")?.textContent?.trim() ?? "",
        text: turn?.innerText ?? "",
      };
    })()`);
    if (state && /^(Ready|Completed|Error|Failed|Idle)$/i.test(state.status)) return state;
    await delay(1_000);
  }
  throw new Error(`等待助手响应超过 ${timeoutMs}ms`);
}

async function startNewChat(session) {
  const result = await session.evaluate(inWebview(`
    const button = [...webviewDocument.querySelectorAll("button")].find((item) => item.textContent?.trim() === "New chat");
    if (!(button instanceof webviewWindow.HTMLButtonElement)) return { ok: false, reason: "New chat missing" };
    button.click();
    return { ok: true };
  `));
  if (!result?.ok) throw new Error(`新建会话失败: ${result?.reason ?? "unknown"}`);
  await delay(500);
}

async function main() {
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  const workbench = await findWorkbenchTarget(port);
  const workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
  await openLoopAgentView(workbenchSession);
  const target = await findWebviewTarget(port);
  const session = await connectCdp(target.webSocketDebuggerUrl);
  const results = [];

  try {
    for (const testCase of cases) {
      await startNewChat(session);
      const startedAt = Date.now();
      const previousCount = await submit(session, testCase.prompt);
      const state = await waitForAssistant(session, previousCount);
      const text = state.text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
      results.push({
        name: testCase.name,
        passed: testCase.validate ? testCase.validate(text) : testCase.expected.test(text),
        status: state.status,
        elapsedMs: Date.now() - startedAt,
        answerLength: text.length,
        hasRunDynamicGraph: text.includes("runDynamicGraph"),
        excerpt: text.slice(-600),
      });
    }
  } finally {
    await session.close();
    await workbenchSession.close();
  }

  const report = { generatedAt: new Date().toISOString(), results };
  writeFileSync(artifactPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ artifactPath, results }, null, 2));
  process.exit(results.every((result) => result.passed) ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
