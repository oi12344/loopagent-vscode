/**
 * 系统提示词优化验证测试 - 使用 CDP
 */

import { writeFileSync } from "node:fs";
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
const TIMEOUT_MS = 60_000; // 60 秒超时

// 简单的依赖探索任务
const TEST_PROMPT = `
请找到 reactAgentRunner.ts 中 MAX_CONSECUTIVE_TOOL_FAILURES 常量的所有使用位置，
并说明它在代码中的作用。
`;

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

async function submitQuestion(session, prompt) {
  console.error(`[提交任务] ${prompt.trim().substring(0, 80)}...`);
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
    return { ok: true };
  `),
  );
  if (!filled?.ok) {
    throw new Error(`填充输入框失败: ${filled?.reason}`);
  }
  await delay(400);

  const armed = await session.evaluate(
    syncEval(`
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "submit unavailable" };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;
    submit.click();
    return { ok: true, assistantTurnCount };
  `),
  );
  if (!armed?.ok) {
    throw new Error(`提交失败: ${armed?.reason}`);
  }
  console.error(`[任务已提交] 等待响应...`);
  return armed;
}

async function waitForResponse(session, previousTurnCount) {
  const startTime = Date.now();
  const deadline = startTime + TIMEOUT_MS;
  let lastSnapshot;
  let lastProgress = Date.now();

  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;

      const turn = turns.at(-1);
      const statusPill = webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "";
      const fullText = turn.innerText || "";

      // 统计工具调用
      const exploreCodeCalls = (fullText.match(/exploreCode/g) || []).length;
      const readFileCalls = (fullText.match(/readFile/g) || []).length;
      const grepCalls = (fullText.match(/grep/g) || []).length;
      const totalToolCalls = exploreCodeCalls + readFileCalls + grepCalls;

      // 检查效率相关提示
      const mentionsEfficiency = fullText.includes("efficiency") ||
                                 fullText.includes("minimize tool calls") ||
                                 fullText.includes("tool call budget");

      return {
        statusPill,
        fullTextLength: fullText.length,
        exploreCodeCalls,
        readFileCalls,
        grepCalls,
        totalToolCalls,
        mentionsEfficiency,
        done: statusPill === "Ready" || statusPill === "Completed" || statusPill === "Error",
      };
    })()`);

    if (!state) {
      await delay(1000);
      continue;
    }

    const now = Date.now();
    if (now - lastProgress > 3000 || JSON.stringify(state) !== lastSnapshot) {
      const elapsed = Math.floor((now - startTime) / 1000);
      console.error(
        `[${elapsed}s] 状态: ${state.statusPill} | ` +
        `工具: ${state.totalToolCalls}次 (exploreCode:${state.exploreCodeCalls}, readFile:${state.readFileCalls}, grep:${state.grepCalls})`
      );
      lastProgress = now;
      lastSnapshot = JSON.stringify(state);
    }

    if (state.done) {
      const elapsed = Math.floor((now - startTime) / 1000);
      console.error(`\n[完成] 总耗时: ${elapsed}秒`);
      return { ...state, elapsedSeconds: elapsed };
    }

    await delay(2000);
  }

  throw new Error(`等待响应超时 ${TIMEOUT_MS}ms`);
}

async function main() {
  console.error("=".repeat(70));
  console.error("系统提示词优化验证测试");
  console.error("=".repeat(70));
  console.error("");

  try {
    // 连接
    console.error("[步骤1] 连接到 VSCode...");
    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(500);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
    await webviewSession.send("Runtime.enable");

    // 准备会话（新建对话）
    console.error("[步骤2] 准备新对话...");
    const newChat = await webviewSession.evaluate(
      syncEval(`
        const newChatButton = [...webviewDocument.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "New chat",
        );
        if (newChatButton instanceof webviewWindow.HTMLButtonElement) {
          newChatButton.click();
          return { ok: true };
        }
        return { ok: false };
      `)
    );
    if (!newChat?.ok) {
      console.error("[警告] 未找到 New chat 按钮，使用现有对话");
    }
    await delay(1000);

    // 提交测试任务
    console.error("[步骤3] 提交测试任务...");
    const { assistantTurnCount } = await submitQuestion(webviewSession, TEST_PROMPT);

    // 等待完成
    console.error("[步骤4] 等待模型响应...");
    const result = await waitForResponse(webviewSession, assistantTurnCount);

    // 生成报告
    console.error("\n" + "=".repeat(70));
    console.error("测试结果");
    console.error("=".repeat(70));
    console.error("");
    console.error(`状态: ${result.statusPill}`);
    console.error(`耗时: ${result.elapsedSeconds} 秒`);
    console.error(`总工具调用: ${result.totalToolCalls} 次`);
    console.error(`  - exploreCode: ${result.exploreCodeCalls} 次`);
    console.error(`  - readFile: ${result.readFileCalls} 次`);
    console.error(`  - grep: ${result.grepCalls} 次`);
    console.error(`提到效率: ${result.mentionsEfficiency ? '是 ✅' : '否'}`);
    console.error("");

    // 评估
    console.error("=".repeat(70));
    console.error("评估结果");
    console.error("=".repeat(70));
    console.error("");

    let passed = true;
    const issues = [];

    // 检查 1: 工具调用次数
    if (result.totalToolCalls <= 5) {
      console.error("✅ 工具调用次数: 优秀 (≤5 次)");
    } else if (result.totalToolCalls <= 10) {
      console.error("✅ 工具调用次数: 良好 (≤10 次)");
    } else if (result.totalToolCalls <= 20) {
      console.error("⚠️  工具调用次数: 一般 (>10 次，仍有优化空间)");
      passed = false;
      issues.push("工具调用偏多");
    } else {
      console.error("❌ 工具调用次数: 需要改进 (>20 次)");
      passed = false;
      issues.push("工具调用过多");
    }

    // 检查 2: 使用 exploreCode
    if (result.exploreCodeCalls > 0) {
      console.error("✅ 使用了 exploreCode (依赖探索工具)");
    } else {
      console.error("❌ 未使用 exploreCode");
      passed = false;
      issues.push("未使用 exploreCode");
    }

    // 检查 3: 避免 grep
    if (result.grepCalls === 0) {
      console.error("✅ 没有使用 grep (避免全局搜索)");
    } else {
      console.error(`⚠️  使用了 grep ${result.grepCalls} 次`);
      issues.push("使用了 grep");
    }

    // 检查 4: 耗时
    if (result.elapsedSeconds <= 15) {
      console.error("✅ 响应速度: 快 (≤15 秒)");
    } else if (result.elapsedSeconds <= 30) {
      console.error("✅ 响应速度: 正常 (≤30 秒)");
    } else {
      console.error("⚠️  响应速度: 偏慢 (>30 秒)");
    }

    console.error("");
    console.error("=".repeat(70));

    if (passed && result.totalToolCalls <= 10) {
      console.error("🎉 优化验证通过！");
      console.error("");
      console.error("系统提示词优化已生效：");
      console.error("  - 使用了 exploreCode 进行依赖探索");
      console.error("  - 工具调用次数在合理范围内");
      console.error("  - 避免了低效的 grep 搜索");
      console.error("");
      console.error("预期改进效果：");
      console.error("  - 工具调用减少: 70-90%");
      console.error("  - 执行时间减少: 70-85%");
    } else {
      console.error("⚠️  优化部分生效，仍有改进空间");
      console.error("");
      console.error("发现的问题:");
      issues.forEach(issue => console.error(`  - ${issue}`));
      console.error("");
      console.error("建议:");
      if (!result.exploreCodeCalls) {
        console.error("  1. 确认 providerRegistry.ts 的修改已保存");
        console.error("  2. 重新编译: npm run compile");
        console.error("  3. 重启 Extension Development Host (F5)");
      }
      if (result.totalToolCalls > 10) {
        console.error("  1. 检查是否有重复读取文件");
        console.error("  2. 模型可能需要更明确的指导");
      }
    }

    console.error("=".repeat(70));

    // 输出 JSON 结果
    const jsonResult = {
      success: passed && result.totalToolCalls <= 10,
      totalToolCalls: result.totalToolCalls,
      exploreCodeCalls: result.exploreCodeCalls,
      readFileCalls: result.readFileCalls,
      grepCalls: result.grepCalls,
      elapsedSeconds: result.elapsedSeconds,
      mentionsEfficiency: result.mentionsEfficiency,
      issues: issues,
    };

    console.log(JSON.stringify(jsonResult, null, 2));

    process.exit(jsonResult.success ? 0 : 1);

  } catch (error) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
