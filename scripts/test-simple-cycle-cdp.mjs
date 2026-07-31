/**
 * 简化版 CDP 测试：最小循环配置
 *
 * 目的：隔离问题，测试最基本的循环功能
 */

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
const CDP_PORT = 9333;
const TURN_TIMEOUT_MS = 180_000; // 3 分钟
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "simple-cycle-test.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "simple-cycle-test.md");

// 最简单的测试提示
const SIMPLE_TEST_PROMPT = `
调用 runDynamicGraph 工具，传入以下配置：

{
  "initialNodes": [
    {
      "id": "step1",
      "task": "返回文本：步骤1完成",
      "role": "executor",
      "exportTo": "result1"
    },
    {
      "id": "step2",
      "task": "返回文本：步骤2完成",
      "role": "executor",
      "dependsOn": ["step1"]
    }
  ],
  "cycles": [
    {
      "id": "simple-loop",
      "from": "step2",
      "to": "step1",
      "exit": {
        "hardLimit": 2
      }
    }
  ]
}

只需调用工具即可，不要做其他事情。
`;

function syncEval(code) {
  return `
    (() => {
      const webviewDocument = document.getElementById("active-frame")?.contentDocument ?? document;
      const webviewWindow = webviewDocument.defaultView ?? window;
      ${code}
    })()
  `;
}

async function main() {
  try {
    console.error("=".repeat(70));
    console.error("简化版循环工作流 CDP 测试");
    console.error("=".repeat(70));
    console.error("");

    mkdirSync(ARTIFACT_DIR, { recursive: true });

    console.error(`[连接] 正在连接到 CDP 端口 ${CDP_PORT}...`);

    // 找到 workbench 目标
    const workbench = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(2000);

    const webview = await findWebviewTarget(CDP_PORT);
    const session = await connectCdp(webview.webSocketDebuggerUrl);

    console.error(`[步骤1] 准备对话会话`);

    // 等待更长时间让 UI 完全加载
    await delay(3000);

    // 先检查页面元素
    const pageInfo = await session.evaluate(
      syncEval(`
        const buttons = [...webviewDocument.querySelectorAll("button")];
        return {
          totalButtons: buttons.length,
          buttonClasses: buttons.map(b => b.className).slice(0, 10),
          buttonTexts: buttons.map(b => b.textContent?.trim()).slice(0, 10),
          hasNewChatButton: !!webviewDocument.querySelector("button.new-chat-button"),
        };
      `),
    );

    console.error(`[调试] 页面按钮信息:`, JSON.stringify(pageInfo, null, 2));

    const started = await session.evaluate(
      syncEval(`
        const newChatButton = webviewDocument.querySelector("button.new-chat-button");
        if (!(newChatButton instanceof webviewWindow.HTMLButtonElement)) {
          // 尝试其他可能的选择器
          const altButton = [...webviewDocument.querySelectorAll("button")]
            .find(b => b.textContent?.includes("新建") || b.textContent?.includes("New"));
          if (altButton instanceof webviewWindow.HTMLButtonElement) {
            altButton.click();
            return { ok: true, method: "alt" };
          }
          return { ok: false, reason: "new chat button missing" };
        }
        newChatButton.click();
        return { ok: true, method: "standard" };
      `),
    );

    if (!started?.ok) {
      throw new Error(`会话准备失败: ${started?.reason ?? "未知状态"}`);
    }
    await delay(1000);
    console.error(`[步骤1] 会话已准备`);

    console.error(`[步骤2] 提交测试...`);
    const payload = JSON.stringify(SIMPLE_TEST_PROMPT);

    const filled = await session.evaluate(
      syncEval(`
        const textarea = webviewDocument.querySelector("#message-input");
        if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) {
          return { ok: false, reason: "textarea missing" };
        }
        const setter = Object.getOwnPropertyDescriptor(
          webviewWindow.HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        if (!setter) return { ok: false, reason: "setter missing" };
        setter.call(textarea, ${payload});
        textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
        return { ok: true };
      `),
    );

    if (!filled?.ok) {
      throw new Error(`填充失败: ${filled?.reason ?? "未知状态"}`);
    }

    const submitted = await session.evaluate(
      syncEval(`
        const sendButton = webviewDocument.querySelector("button.send-button");
        if (!(sendButton instanceof webviewWindow.HTMLButtonElement)) {
          // 尝试查找包含 "Send" 文本的按钮
          const altButton = [...webviewDocument.querySelectorAll("button")]
            .find(b => b.textContent?.trim() === "Send");
          if (altButton instanceof webviewWindow.HTMLButtonElement) {
            altButton.click();
            return { ok: true, method: "alt" };
          }
          return { ok: false, reason: "send button missing" };
        }
        sendButton.click();
        return { ok: true, method: "standard" };
      `),
    );

    if (!submitted?.ok) {
      throw new Error(`提交失败: ${submitted?.reason ?? "未知状态"}`);
    }

    console.error(`[步骤2] 任务已提交，等待响应...`);

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let previousTurnCount = 0;
    let lastProgress = 0;
    let lastSnapshot = "";

    let usedDynamicGraph = false;
    let detectedCycle = false;
    let cycleIterations = 0;
    let workflowCompleted = false;

    while (Date.now() < deadline) {
      const state = await session.evaluate(`(() => {
        const webviewDocument =
          document.getElementById("active-frame")?.contentDocument ?? document;
        const webviewWindow = webviewDocument.defaultView ?? window;
        const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
        if (turns.length <= ${previousTurnCount}) return null;

        const turn = turns.at(-1);
        const statusPill = webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "";
        const fullContent = turn?.innerText ?? "";

        // 检测关键词
        const hasRunDynamicGraph = fullContent.includes("runDynamicGraph");
        const hasCycleKeywords = fullContent.includes("循环") || fullContent.includes("cycle") || fullContent.includes("CycleTriggered");
        const hasCompleted = fullContent.includes("completed") || fullContent.includes("完成") || fullContent.includes("workflowStatus");

        // 尝试提取轮数
        const iterationMatch = fullContent.match(/第\\s*(\\d+)\\s*轮/) || fullContent.match(/iteration[:\\s]*(\\d+)/i);
        const iteration = iterationMatch ? parseInt(iterationMatch[1]) : 0;

        const toolCalls = [...turn.querySelectorAll("[class*='tool']")].length;

        return {
          statusPill,
          fullContentLength: fullContent.length,
          toolCalls,
          hasRunDynamicGraph,
          hasCycleKeywords,
          iteration,
          hasCompleted,
          contentPreview: fullContent.substring(0, 300)
        };
      })()`);

      if (!state) {
        await delay(1000);
        continue;
      }

      const now = Date.now();

      // 更新检测状态
      if (state.hasRunDynamicGraph && !usedDynamicGraph) {
        usedDynamicGraph = true;
        console.error(`\n[检测] ✅ 检测到 runDynamicGraph 工具调用！`);
      }

      if (state.hasCycleKeywords && !detectedCycle) {
        detectedCycle = true;
        console.error(`[检测] ✅ 检测到循环关键词！`);
      }

      if (state.iteration > cycleIterations) {
        cycleIterations = state.iteration;
        console.error(`[检测] 🔄 循环轮数: ${cycleIterations}`);
      }

      if (state.hasCompleted && !workflowCompleted) {
        workflowCompleted = true;
        console.error(`[检测] ✅ 工作流完成！`);
      }

      // 输出进度
      if (now - lastProgress > 3000 || JSON.stringify(state) !== lastSnapshot) {
        const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
        console.error(
          `[进度] 内容: ${state.fullContentLength}字 | 工具: ${state.toolCalls}次 | 动态图: ${usedDynamicGraph ? '✅' : '❌'} | 循环: ${detectedCycle ? '✅' : '❌'} | 轮数: ${cycleIterations} | 耗时: ${elapsed}s`
        );

        if (state.contentPreview) {
          console.error(`[预览] ${state.contentPreview.substring(0, 150)}...`);
        }

        lastProgress = now;
        lastSnapshot = JSON.stringify(state);
      }

      // 检查完成条件
      if (state.statusPill === "Completed" || (workflowCompleted && state.toolCalls > 0)) {
        console.error(`\n[完成] 测试完成，状态: ${state.statusPill}`);
        break;
      }

      await delay(1000);
    }

    if (Date.now() >= deadline) {
      console.error(`\n[超时] 测试在 ${TURN_TIMEOUT_MS / 1000}s 后超时`);
    }

    console.error(`\n[步骤3] 保存截图...`);
    try {
      await session.send("Page.enable");
      const { data } = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      writeFileSync(SCREENSHOT_PATH, Buffer.from(data, "base64"));
      console.error(`[步骤3] 截图已保存`);
    } catch (error) {
      console.error(`[步骤3] 截图失败（非致命）: ${error.message}`);
    }

    console.error(`[步骤4] 保存报告...`);
    const transcript = await session.evaluate(
      syncEval(`
        return [...webviewDocument.querySelectorAll(".message")]
          .map(m => m.innerText)
          .join("\\n\\n---\\n\\n");
      `),
    );
    writeFileSync(TRANSCRIPT_PATH, transcript || "无内容", "utf-8");

    console.error("\n" + "=".repeat(70));
    console.error("测试完成");
    console.error("=".repeat(70));

    const result = {
      success: workflowCompleted && usedDynamicGraph,
      usedDynamicGraph,
      detectedCycle,
      cycleIterations,
      workflowCompleted,
      screenshotPath: SCREENSHOT_PATH,
      transcriptPath: TRANSCRIPT_PATH,
    };

    console.log(JSON.stringify(result, null, 2));

    process.exit(result.success ? 0 : 1);

  } catch (error) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
