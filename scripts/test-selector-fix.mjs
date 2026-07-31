/**
 * 快速验证脚本 - 测试修复后的 DOM 选择器
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

async function testSelectors() {
  console.log("============================================================");
  console.log("测试修复后的选择器");
  console.log("============================================================");

  try {
    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(2000);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    await webviewSession.send("Runtime.enable");

    // 使用修复后的选择器逻辑
    console.log("\n[测试] 提取最后一条 assistant 消息");
    const result = await webviewSession.evaluate(`(() => {
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length === 0) return { error: "没有 assistant 消息" };

      const turn = turns.at(-1);
      const statusPill = webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "";

      // 提取推理过程 - 使用更通用的方法
      let reasoning = "";
      const thinkingSelectors = [".thinking-block", ".思考过程", "[class*='thinking']", "[class*='reasoning']"];
      for (const selector of thinkingSelectors) {
        const blocks = [...turn.querySelectorAll(selector)];
        if (blocks.length > 0) {
          reasoning = blocks.map(b => b.innerText).join("\\n");
          break;
        }
      }

      if (!reasoning) {
        reasoning = turn.innerText || "";
      }

      // 提取工具调用
      let toolCallCount = 0;
      const toolSelectors = [".tool-call", ".工具调用", "[class*='tool']", "[class*='execution']"];
      for (const selector of toolSelectors) {
        const calls = [...turn.querySelectorAll(selector)];
        if (calls.length > 0) {
          toolCallCount = calls.length;
          break;
        }
      }

      const content = turn.querySelector(".message-content")?.innerText ?? turn.innerText ?? "";
      const fullText = turn.innerText || "";
      const usedDynamicWorkflow = fullText.includes("runDynamicGraph") || fullText.includes("动态工作流");

      return {
        ok: true,
        statusPill,
        reasoningLength: reasoning.length,
        reasoningPreview: reasoning.substring(0, 200),
        toolCallCount,
        contentLength: content.length,
        contentPreview: content.substring(0, 200),
        usedDynamicWorkflow,
      };
    })()`);

    console.log("\n结果:");
    console.log(JSON.stringify(result, null, 2));

    if (result.reasoningLength > 0) {
      console.log("\n✅ 成功提取到推理过程！");
    } else {
      console.log("\n⚠️  未提取到推理过程");
    }

    if (result.statusPill) {
      console.log(`✅ 状态: ${result.statusPill}`);
    }

    if (result.usedDynamicWorkflow) {
      console.log("✅ 检测到动态工作流！");
    } else {
      console.log("❌ 未检测到动态工作流");
    }

    console.log("\n============================================================");
    console.log("测试完成");
    console.log("============================================================");

  } catch (error) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

testSelectors();
