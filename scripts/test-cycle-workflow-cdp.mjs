/**
 * CDP E2E 测试：验证动态工作流的循环功能
 *
 * 测试场景：使用真实的 VSCode 实例，通过 CDP 发送包含循环的动态工作流请求，
 * 验证循环能够正确触发、执行和退出。
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
const TURN_TIMEOUT_MS = 300_000; // 5 分钟超时（循环任务）
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "cycle-workflow-test.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "cycle-workflow-test.md");

// 测试提示：简单的审查-修复循环（优化版）
const CYCLE_TEST_PROMPT = `
请调用 runDynamicGraph 工具，配置如下：

{
  "initialNodes": [
    {
      "id": "write-function",
      "task": "编写一个简单的 JavaScript 函数 add(a, b)，返回两数之和。故意不添加类型定义和参数验证。",
      "role": "executor"
    },
    {
      "id": "code-review",
      "task": "审查代码质量。检查：1) 是否有类型定义 2) 是否有参数验证 3) 是否有错误处理。如果所有检查通过，回复「APPROVED: 代码审查通过」。否则列出具体问题。",
      "role": "reviewer",
      "dependsOn": ["write-function"],
      "exportTo": "reviewResult"
    },
    {
      "id": "fix-code",
      "task": "根据审查意见修复代码问题。审查结果：{reviewResult}",
      "role": "executor",
      "dependsOn": ["code-review"],
      "inputMapping": {
        "reviewResult": "globalData.reviewResult"
      },
      "condition": {
        "type": "custom",
        "expression": "!code-review.content.includes('APPROVED')"
      }
    }
  ],
  "cycles": [
    {
      "id": "review-fix-loop",
      "from": "fix-code",
      "to": "code-review",
      "exit": {
        "hardLimit": 3,
        "breakWhen": [
          {
            "type": "expression",
            "value": "code-review.content.includes('APPROVED')",
            "description": "代码审查通过"
          }
        ]
      }
    }
  ]
}
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

async function prepareConversation(session) {
  console.error(`[步骤1] 准备对话会话`);
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
  await delay(1000);
  console.error(`[步骤1] 会话已准备`);
}

async function submitQuestion(session, prompt) {
  console.error(`[步骤2] 提交循环工作流测试...`);
  console.error(`[步骤2] 提示长度: ${prompt.length} 字符`);
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

  const armed = await session.evaluate(
    syncEval(`
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "submit unavailable (disabled=" + submit?.disabled + ")" };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;
    submit.click();
    return { ok: true, assistantTurnCount };
  `),
  );
  if (!armed?.ok) {
    throw new Error(`提交失败: ${armed?.reason ?? "未知 Webview 状态"}`);
  }
  console.error(`[步骤2] 任务已提交，等待响应...`);
  return armed;
}

async function waitForResponse(session, previousTurnCount) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastSnapshot;
  let lastProgress = Date.now();
  let detectedCycle = false;
  let cycleIterations = 0;

  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const webviewWindow = webviewDocument.defaultView ?? window;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;

      const turn = turns.at(-1);
      const meta = turn?.querySelector(".message-meta")?.innerText ?? "";
      const statusPill = webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "";

      // 提取完整内容
      const fullContent = turn?.innerText ?? "";

      // 检测循环相关的关键词
      const hasCycleKeywords = fullContent.includes("循环") ||
                               fullContent.includes("cycle") ||
                               fullContent.includes("review-fix-loop") ||
                               fullContent.includes("CycleTriggered");

      // 改进：更准确地检测循环迭代次数
      // 方法1: 查找 CycleTriggered 事件中的 iteration
      let iterationMatch = fullContent.match(/CycleTriggered.*?iteration[:\s]*(\d+)/i);
      // 方法2: 查找中文"第 X 轮"
      if (!iterationMatch) {
        iterationMatch = fullContent.match(/第\s*(\d+)\s*轮/);
      }
      // 方法3: 查找 "iteration: X"
      if (!iterationMatch) {
        iterationMatch = fullContent.match(/iteration[:\s]*(\d+)/i);
      }
      const iteration = iterationMatch ? parseInt(iterationMatch[1]) : 0;

      // 改进：检测节点执行进度 (X / Y)
      const progressMatch = fullContent.match(/(\d+)\s*\/\s*(\d+)/);
      let nodesCompleted = 0;
      let nodesTotal = 0;
      if (progressMatch) {
        nodesCompleted = parseInt(progressMatch[1]);
        nodesTotal = parseInt(progressMatch[2]);
      }

      // 检测退出条件
      const hasApproved = fullContent.includes("APPROVED") || fullContent.includes("审查通过");

      // 改进：更严格的完成检测
      const hasWorkflowStatusCompleted =
        fullContent.includes('\\"workflowStatus\\":\\"completed\\"') ||
        fullContent.includes('\\"status\\":\\"completed\\"');
      const hasCompleted = hasWorkflowStatusCompleted ||
                          (fullContent.includes("completed") || fullContent.includes("完成"));

      // 工具调用统计
      const toolCalls = [...turn.querySelectorAll("[class*='tool']")].length;
      const usedDynamicGraph = fullContent.includes("runDynamicGraph") ||
                               fullContent.includes("动态工作流") ||
                               fullContent.includes("dynamicGraph");

      return {
        meta,
        statusPill,
        fullContentLength: fullContent.length,
        toolCalls,
        usedDynamicGraph,
        hasCycleKeywords,
        iteration,
        nodesCompleted,
        nodesTotal,
        hasApproved,
        hasCompleted,
        hasWorkflowStatusCompleted,
        contentPreview: fullContent.substring(0, 500)
      };
    })()`);

    if (!state) {
      await delay(1000);
      continue;
    }

    const now = Date.now();

    // 检测循环触发
    if (state.hasCycleKeywords && !detectedCycle) {
      detectedCycle = true;
      console.error(`\n[检测] ✅ 检测到循环关键词！`);
    }

    // 追踪循环轮数
    if (state.iteration > cycleIterations) {
      cycleIterations = state.iteration;
      console.error(`[检测] 🔄 循环轮数: ${cycleIterations}`);
    }

    if (now - lastProgress > 3000 || JSON.stringify(state) !== lastSnapshot) {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(
        `[进度] 内容: ${state.fullContentLength}字 | 工具: ${state.toolCalls}次 | 动态图: ${state.usedDynamicGraph ? '✅' : '❌'} | 循环: ${detectedCycle ? '✅' : '❌'} | 轮数: ${cycleIterations} | 耗时: ${elapsed}s`
      );

      if (state.hasCycleKeywords || state.iteration > 0) {
        console.error(`[内容预览] ${state.contentPreview.substring(0, 200)}...`);
      }

      lastProgress = now;
      lastSnapshot = JSON.stringify(state);
    }

    if (state.statusPill === "Completed" || state.statusPill === "Error") {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(`\n[完成] 总耗时 ${elapsed}s`);

      // 验证结果
      console.error(`\n[验证结果]`);
      console.error(`  动态工作流: ${state.usedDynamicGraph ? '✅ 已使用' : '❌ 未使用'}`);
      console.error(`  循环机制: ${detectedCycle ? '✅ 已触发' : '❌ 未触发'}`);
      console.error(`  循环轮数: ${cycleIterations} 轮`);
      console.error(`  审查通过: ${state.hasApproved ? '✅ 是' : '❌ 否'}`);

      if (!state.usedDynamicGraph) {
        console.error(`\n[警告] ⚠️  未使用动态工作流，可能模型选择了其他方式`);
      }

      if (!detectedCycle && state.usedDynamicGraph) {
        console.error(`\n[警告] ⚠️  使用了动态工作流但未检测到循环关键词`);
      }

      return {
        ...state,
        detectedCycle,
        cycleIterations,
        elapsed
      };
    }

    await delay(2000);
  }

  throw new Error(`等待响应超时 ${TURN_TIMEOUT_MS}ms。最后状态: ${lastSnapshot}`);
}

async function captureScreenshot(session, path) {
  console.error(`\n[步骤3] 保存截图`);
  await session.send("Page.enable");
  const { data } = await session.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  writeFileSync(path, Buffer.from(data, "base64"));
  console.error(`[步骤3] 截图已保存: ${path}`);
}

async function saveTranscript(session, previousTurnCount, path, testResult) {
  console.error(`\n[步骤4] 生成测试报告`);

  const transcript = await session.evaluate(`(() => {
    const webviewDocument =
      document.getElementById("active-frame")?.contentDocument ?? document;
    const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
    if (turns.length <= ${previousTurnCount}) return { turns: [] };

    const turn = turns.at(-1);
    const fullContent = turn?.innerText ?? "";

    return {
      fullContent,
      contentLength: fullContent.length
    };
  })()`);

  let markdown = `# 循环工作流 CDP 测试报告\n\n`;
  markdown += `**测试时间**: ${new Date().toISOString()}\n`;
  markdown += `**总耗时**: ${testResult.elapsed} 秒\n\n`;

  markdown += `## 测试目标\n\n`;
  markdown += `验证动态工作流的智能循环功能：\n`;
  markdown += `- 循环边能否正确触发\n`;
  markdown += `- 智能退出条件是否生效\n`;
  markdown += `- 节点能否正确重置和重新执行\n\n`;

  markdown += `---\n\n`;

  markdown += `## 用户请求\n\n`;
  markdown += `\`\`\`\n${CYCLE_TEST_PROMPT}\n\`\`\`\n\n`;
  markdown += `---\n\n`;

  markdown += `## 测试结果\n\n`;

  // 动态工作流检测
  markdown += `### 1. 动态工作流使用\n`;
  if (testResult.usedDynamicGraph) {
    markdown += `✅ **已使用** runDynamicGraph 工具\n\n`;
  } else {
    markdown += `❌ **未使用** 动态工作流（可能模型选择了其他实现方式）\n\n`;
  }

  // 循环检测
  markdown += `### 2. 循环机制触发\n`;
  if (testResult.detectedCycle) {
    markdown += `✅ **已触发** 循环机制\n`;
    markdown += `- 循环轮数: **${testResult.cycleIterations} 轮**\n\n`;
  } else {
    markdown += `❌ **未触发** 循环（在输出中未检测到循环关键词）\n\n`;
  }

  // 退出条件
  markdown += `### 3. 智能退出\n`;
  if (testResult.hasApproved) {
    markdown += `✅ **退出条件满足** - 检测到 "APPROVED" 或"审查通过"\n\n`;
  } else {
    markdown += `⚠️  **未明确检测到退出条件** - 可能达到硬上限或其他原因退出\n\n`;
  }

  markdown += `---\n\n`;

  markdown += `## 助手完整响应\n\n`;
  markdown += `\`\`\`\n${transcript.fullContent}\n\`\`\`\n\n`;
  markdown += `---\n\n`;

  markdown += `## 结论\n\n`;

  const allPassed = testResult.usedDynamicGraph && testResult.detectedCycle;

  if (allPassed) {
    markdown += `### ✅ 测试通过\n\n`;
    markdown += `循环工作流功能正常：\n`;
    markdown += `- ✅ 正确使用 runDynamicGraph\n`;
    markdown += `- ✅ 循环机制成功触发\n`;
    markdown += `- ✅ 执行了 ${testResult.cycleIterations} 轮循环\n`;
    markdown += `- ${testResult.hasApproved ? '✅' : '⚠️ '} 智能退出${testResult.hasApproved ? '正常' : '需要进一步验证'}\n\n`;
  } else {
    markdown += `### ⚠️  测试部分通过\n\n`;
    if (!testResult.usedDynamicGraph) {
      markdown += `- ❌ 未使用动态工作流\n`;
      markdown += `  - 可能原因：模型选择了其他实现方式\n`;
      markdown += `  - 建议：在提示中更明确地要求使用 runDynamicGraph\n\n`;
    }
    if (!testResult.detectedCycle) {
      markdown += `- ❌ 未检测到循环触发\n`;
      markdown += `  - 可能原因：循环未触发，或输出中未包含循环关键词\n`;
      markdown += `  - 建议：检查工作流定义是否正确\n\n`;
    }
  }

  writeFileSync(path, markdown, "utf-8");
  console.error(`[步骤4] 报告已保存: ${path}`);

  return transcript;
}

async function main() {
  console.error("=".repeat(70));
  console.error("循环工作流 CDP E2E 测试");
  console.error("=".repeat(70));

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });

    // 连接到 VS Code Workbench
    console.error(`\n[连接] 正在连接到 CDP 端口 ${CDP_PORT}...`);
    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(2000);

    // 连接到 Webview
    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    // 准备会话
    await prepareConversation(webviewSession);

    // 提交测试请求
    const { assistantTurnCount } = await submitQuestion(webviewSession, CYCLE_TEST_PROMPT);

    // 等待完成并收集结果
    const testResult = await waitForResponse(webviewSession, assistantTurnCount);

    // 截图
    await captureScreenshot(webviewSession, SCREENSHOT_PATH);

    // 保存报告
    await saveTranscript(webviewSession, assistantTurnCount, TRANSCRIPT_PATH, testResult);

    console.error("\n" + "=".repeat(70));
    console.error("测试完成");
    console.error("=".repeat(70));

    const result = {
      success: testResult.statusPill === "Completed",
      usedDynamicGraph: testResult.usedDynamicGraph,
      detectedCycle: testResult.detectedCycle,
      cycleIterations: testResult.cycleIterations,
      hasApproved: testResult.hasApproved,
      elapsed: testResult.elapsed,
      screenshotPath: SCREENSHOT_PATH,
      transcriptPath: TRANSCRIPT_PATH,
    };

    console.log(JSON.stringify(result, null, 2));

    // 判断测试是否通过
    const testPassed = result.success && result.usedDynamicGraph && result.detectedCycle;
    process.exit(testPassed ? 0 : 1);

  } catch (error) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
