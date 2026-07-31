/**
 * 诊断脚本 - 检查为什么消息提交后没有响应
 */

import {
  connectCdp,
  delay,
  findWebviewTarget,
  findWorkbenchTarget,
  openLoopAgentView,
} from "./cdpClient.mjs";

const CDP_PORT = 9333;

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

async function diagnose() {
  console.log("============================================================");
  console.log("诊断 Webview 状态");
  console.log("============================================================");

  try {
    // 连接到 Workbench
    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(2000);

    // 连接到 Webview
    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    await webviewSession.send("Runtime.enable");

    // 检查 Webview 基本状态
    console.log("\n[检查 1] Webview 基本状态");
    const basicState = await webviewSession.evaluate(
      syncEval(`
        return {
          ok: true,
          hasDocument: !!webviewDocument,
          hasWindow: !!webviewWindow,
          title: webviewDocument?.title || "unknown",
        };
      `)
    );
    console.log(JSON.stringify(basicState, null, 2));

    // 检查输入框
    console.log("\n[检查 2] 输入框状态");
    const inputState = await webviewSession.evaluate(
      syncEval(`
        const textarea = webviewDocument.querySelector("#message-input");
        return {
          ok: true,
          found: !!textarea,
          type: textarea?.tagName,
          disabled: textarea?.disabled,
          value: textarea?.value?.substring(0, 50),
        };
      `)
    );
    console.log(JSON.stringify(inputState, null, 2));

    // 检查提交按钮
    console.log("\n[检查 3] 提交按钮状态");
    const buttonState = await webviewSession.evaluate(
      syncEval(`
        const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
        return {
          ok: true,
          found: !!submit,
          type: submit?.tagName,
          disabled: submit?.disabled,
          text: submit?.textContent,
        };
      `)
    );
    console.log(JSON.stringify(buttonState, null, 2));

    // 检查现有对话
    console.log("\n[检查 4] 现有对话消息");
    const messagesState = await webviewSession.evaluate(
      syncEval(`
        const userMessages = [...webviewDocument.querySelectorAll(".message-user")];
        const assistantMessages = [...webviewDocument.querySelectorAll(".message-assistant")];
        return {
          ok: true,
          userCount: userMessages.length,
          assistantCount: assistantMessages.length,
          lastUserMessage: userMessages.at(-1)?.innerText?.substring(0, 100) || "none",
          lastAssistantMessage: assistantMessages.at(-1)?.innerText?.substring(0, 100) || "none",
        };
      `)
    );
    console.log(JSON.stringify(messagesState, null, 2));

    // 检查状态指示器
    console.log("\n[检查 5] 状态指示器");
    const statusState = await webviewSession.evaluate(
      syncEval(`
        const statusPill = webviewDocument.querySelector(".status-pill");
        const thinkingBlocks = webviewDocument.querySelectorAll(".thinking-block");
        const toolCalls = webviewDocument.querySelectorAll(".tool-call");
        return {
          ok: true,
          hasStatusPill: !!statusPill,
          statusText: statusPill?.textContent?.trim() || "none",
          thinkingBlockCount: thinkingBlocks.length,
          toolCallCount: toolCalls.length,
        };
      `)
    );
    console.log(JSON.stringify(statusState, null, 2));

    // 检查 DOM 结构
    console.log("\n[检查 6] DOM 选择器验证");
    const selectorState = await webviewSession.evaluate(
      syncEval(`
        const selectors = {
          messageInput: "#message-input",
          submitButton: 'form.chat-composer button[type="submit"]',
          newChatButton: "button",
          messageUser: ".message-user",
          messageAssistant: ".message-assistant",
          statusPill: ".status-pill",
          thinkingBlock: ".thinking-block",
          toolCall: ".tool-call",
        };

        const results = {};
        for (const [name, selector] of Object.entries(selectors)) {
          const elements = webviewDocument.querySelectorAll(selector);
          results[name] = {
            selector,
            count: elements.length,
            found: elements.length > 0,
          };
        }

        return { ok: true, selectors: results };
      `)
    );
    console.log(JSON.stringify(selectorState, null, 2));

    console.log("\n============================================================");
    console.log("诊断完成");
    console.log("============================================================");

  } catch (error) {
    console.error(`\n❌ 诊断失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

diagnose();
