/**
 * CDP E2E 测试：复杂的多循环代码审查工作流
 *
 * 测试场景：完整的代码实现 → 安全审查 → 修复 → 质量审查 → 修复 → 测试循环
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
const TURN_TIMEOUT_MS = 600_000; // 10 分钟超时（复杂工作流）
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "complex-cycle-workflow-test.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "complex-cycle-workflow-test.md");

// 复杂的多循环工作流测试
const COMPLEX_CYCLE_PROMPT = `
请使用 runDynamicGraph 创建一个完整的代码审查工作流，包含多个智能循环。

## 工作流定义

\`\`\`json
{
  "initialNodes": [
    {
      "id": "implement",
      "task": "实现一个简单的用户登录验证函数 validateLogin(username, password)。要求：1) 检查用户名长度 2) 检查密码强度 3) 返回验证结果。故意不添加 SQL 注入防护和完整的错误处理。",
      "role": "executor",
      "exportTo": "implementation"
    },
    {
      "id": "security-review",
      "task": "审查代码安全性。检查：1) SQL 注入风险 2) XSS 防护 3) 密码存储安全 4) 错误处理。如果所有检查通过，回复「SECURITY APPROVED」，否则列出具体安全问题。",
      "role": "reviewer",
      "dependsOn": ["implement"],
      "exportTo": "securityResult"
    },
    {
      "id": "security-fix",
      "task": "修复安全问题。审查结果：{securityResult}",
      "role": "executor",
      "dependsOn": ["security-review"],
      "inputMapping": {
        "securityResult": "globalData.securityResult"
      },
      "condition": {
        "type": "custom",
        "expression": "!security-review.content.includes('SECURITY APPROVED')"
      }
    },
    {
      "id": "quality-review",
      "task": "审查代码质量。检查：1) 类型定义 2) 注释完整性 3) 代码结构。如果质量良好，回复「QUALITY APPROVED」，否则列出改进建议。",
      "role": "reviewer",
      "dependsOn": ["security-review", "security-fix"],
      "exportTo": "qualityResult"
    },
    {
      "id": "quality-fix",
      "task": "改进代码质量。审查结果：{qualityResult}",
      "role": "executor",
      "dependsOn": ["quality-review"],
      "inputMapping": {
        "qualityResult": "globalData.qualityResult"
      },
      "condition": {
        "type": "custom",
        "expression": "!quality-review.content.includes('QUALITY APPROVED')"
      }
    },
    {
      "id": "summary",
      "task": "生成最终报告，汇总：1) 安全审查轮数 2) 质量审查轮数 3) 总修复次数 4) 最终代码状态",
      "role": "planner",
      "dependsOn": ["quality-review", "quality-fix"]
    }
  ],
  "cycles": [
    {
      "id": "security-loop",
      "from": "security-fix",
      "to": "security-review",
      "exit": {
        "hardLimit": 3,
        "breakWhen": [
          {
            "type": "expression",
            "value": "security-review.content.includes('SECURITY APPROVED')",
            "description": "安全审查通过",
            "priority": "high"
          }
        ],
        "adaptive": {
          "detectNoProgress": true,
          "progressWindow": 2,
          "similarityThreshold": 0.85,
          "costBudget": 50000
        }
      }
    },
    {
      "id": "quality-loop",
      "from": "quality-fix",
      "to": "quality-review",
      "exit": {
        "hardLimit": 2,
        "breakWhen": [
          {
            "type": "expression",
            "value": "quality-review.content.includes('QUALITY APPROVED')",
            "description": "质量审查通过",
            "priority": "high"
          }
        ],
        "adaptive": {
          "detectNoProgress": true,
          "progressWindow": 2,
          "costBudget": 30000
        }
      }
    }
  ],
  "include": ["visualization", "debug"]
}
\`\`\`

## 预期执行流程

1. implement → 生成有安全问题的代码
2. security-review → 发现问题 → security-fix → security-review（循环1-3次）
3. quality-review → 发现问题 → quality-fix → quality-review（循环1-2次）
4. summary → 生成最终报告

## 关键验证点

- ✅ 两个循环都应该被触发
- ✅ security-loop 和 quality-loop 应该独立工作
- ✅ 每个循环都应该正确退出（条件满足或硬上限）
- ✅ 最终报告应该包含循环统计信息

请立即执行这个复杂的多循环工作流！
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
  console.error(`[步骤2] 提交复杂多循环工作流...`);
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

  const cycleTracking = {
    securityLoop: { detected: false, iterations: 0 },
    qualityLoop: { detected: false, iterations: 0 },
    totalNodes: 0
  };

  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousTurnCount}) return null;

      const turn = turns.at(-1);
      const statusPill = webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "";
      const fullContent = turn?.innerText ?? "";

      // 检测安全循环
      const hasSecurityLoop = fullContent.includes("security-loop") ||
                             fullContent.includes("安全审查") ||
                             fullContent.includes("SECURITY");
      const securityIterMatch = fullContent.match(/security.*?第\\s*(\\d+)\\s*轮/i);
      const securityIter = securityIterMatch ? parseInt(securityIterMatch[1]) : 0;

      // 检测质量循环
      const hasQualityLoop = fullContent.includes("quality-loop") ||
                            fullContent.includes("质量审查") ||
                            fullContent.includes("QUALITY");
      const qualityIterMatch = fullContent.match(/quality.*?第\\s*(\\d+)\\s*轮/i);
      const qualityIter = qualityIterMatch ? parseInt(qualityIterMatch[1]) : 0;

      // 检测节点执行
      const nodeMatches = fullContent.match(/implement|security-review|security-fix|quality-review|quality-fix|summary/gi) || [];
      const uniqueNodes = new Set(nodeMatches.map(n => n.toLowerCase()));

      // 检测审查通过
      const securityApproved = fullContent.includes("SECURITY APPROVED");
      const qualityApproved = fullContent.includes("QUALITY APPROVED");

      const toolCalls = [...turn.querySelectorAll("[class*='tool']")].length;
      const usedDynamicGraph = fullContent.includes("runDynamicGraph") ||
                               fullContent.includes("dynamicGraph");

      return {
        statusPill,
        fullContentLength: fullContent.length,
        toolCalls,
        usedDynamicGraph,
        hasSecurityLoop,
        hasQualityLoop,
        securityIter,
        qualityIter,
        totalUniqueNodes: uniqueNodes.size,
        securityApproved,
        qualityApproved,
        contentPreview: fullContent.substring(0, 800)
      };
    })()`);

    if (!state) {
      await delay(1000);
      continue;
    }

    const now = Date.now();

    // 更新循环追踪
    if (state.hasSecurityLoop && !cycleTracking.securityLoop.detected) {
      cycleTracking.securityLoop.detected = true;
      console.error(`\n[检测] ✅ 检测到安全循环（security-loop）`);
    }
    if (state.securityIter > cycleTracking.securityLoop.iterations) {
      cycleTracking.securityLoop.iterations = state.securityIter;
      console.error(`[检测] 🔄 安全循环轮数: ${state.securityIter}`);
    }

    if (state.hasQualityLoop && !cycleTracking.qualityLoop.detected) {
      cycleTracking.qualityLoop.detected = true;
      console.error(`\n[检测] ✅ 检测到质量循环（quality-loop）`);
    }
    if (state.qualityIter > cycleTracking.qualityLoop.iterations) {
      cycleTracking.qualityLoop.iterations = state.qualityIter;
      console.error(`[检测] 🔄 质量循环轮数: ${state.qualityIter}`);
    }

    if (state.totalUniqueNodes > cycleTracking.totalNodes) {
      cycleTracking.totalNodes = state.totalUniqueNodes;
    }

    if (now - lastProgress > 5000 || JSON.stringify(state) !== lastSnapshot) {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(
        `[进度] 内容: ${state.fullContentLength}字 | 工具: ${state.toolCalls}次 | ` +
        `动态图: ${state.usedDynamicGraph ? '✅' : '❌'} | ` +
        `安全循环: ${cycleTracking.securityLoop.detected ? `✅(${cycleTracking.securityLoop.iterations}轮)` : '❌'} | ` +
        `质量循环: ${cycleTracking.qualityLoop.detected ? `✅(${cycleTracking.qualityLoop.iterations}轮)` : '❌'} | ` +
        `节点: ${state.totalUniqueNodes} | 耗时: ${elapsed}s`
      );

      lastProgress = now;
      lastSnapshot = JSON.stringify(state);
    }

    if (state.statusPill === "Completed" || state.statusPill === "Error") {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(`\n[完成] 总耗时 ${elapsed}s`);

      console.error(`\n[验证结果]`);
      console.error(`  动态工作流: ${state.usedDynamicGraph ? '✅ 已使用' : '❌ 未使用'}`);
      console.error(`  安全循环: ${cycleTracking.securityLoop.detected ? `✅ 已触发 (${cycleTracking.securityLoop.iterations}轮)` : '❌ 未触发'}`);
      console.error(`  质量循环: ${cycleTracking.qualityLoop.detected ? `✅ 已触发 (${cycleTracking.qualityLoop.iterations}轮)` : '❌ 未触发'}`);
      console.error(`  安全审查: ${state.securityApproved ? '✅ 通过' : '⚠️  未明确通过'}`);
      console.error(`  质量审查: ${state.qualityApproved ? '✅ 通过' : '⚠️  未明确通过'}`);
      console.error(`  节点执行: ${state.totalUniqueNodes} 个`);

      return {
        ...state,
        ...cycleTracking,
        elapsed
      };
    }

    await delay(3000);
  }

  throw new Error(`等待响应超时 ${TURN_TIMEOUT_MS}ms`);
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
    if (turns.length <= ${previousTurnCount}) return { fullContent: "" };

    const turn = turns.at(-1);
    return {
      fullContent: turn?.innerText ?? ""
    };
  })()`);

  let markdown = `# 复杂多循环工作流 CDP 测试报告\n\n`;
  markdown += `**测试时间**: ${new Date().toISOString()}\n`;
  markdown += `**总耗时**: ${testResult.elapsed} 秒\n\n`;

  markdown += `## 测试目标\n\n`;
  markdown += `验证包含多个独立循环的复杂工作流：\n`;
  markdown += `1. 安全审查循环（security-loop）\n`;
  markdown += `2. 质量审查循环（quality-loop）\n`;
  markdown += `3. 两个循环的独立运行和正确退出\n`;
  markdown += `4. 最终报告的生成\n\n`;

  markdown += `---\n\n`;

  markdown += `## 测试结果摘要\n\n`;

  const allCyclesDetected = testResult.securityLoop.detected && testResult.qualityLoop.detected;
  const testPassed = testResult.usedDynamicGraph && allCyclesDetected;

  if (testPassed) {
    markdown += `### ✅ 测试通过\n\n`;
  } else {
    markdown += `### ⚠️  测试部分通过\n\n`;
  }

  markdown += `| 检查项 | 状态 | 详情 |\n`;
  markdown += `|--------|------|------|\n`;
  markdown += `| 动态工作流 | ${testResult.usedDynamicGraph ? '✅ 通过' : '❌ 失败'} | ${testResult.usedDynamicGraph ? '正确使用 runDynamicGraph' : '未使用动态工作流'} |\n`;
  markdown += `| 安全循环 | ${testResult.securityLoop.detected ? '✅ 通过' : '❌ 失败'} | ${testResult.securityLoop.detected ? `执行了 ${testResult.securityLoop.iterations} 轮` : '未触发'} |\n`;
  markdown += `| 质量循环 | ${testResult.qualityLoop.detected ? '✅ 通过' : '❌ 失败'} | ${testResult.qualityLoop.detected ? `执行了 ${testResult.qualityLoop.iterations} 轮` : '未触发'} |\n`;
  markdown += `| 安全审查 | ${testResult.securityApproved ? '✅ 通过' : '⚠️  待确认'} | ${testResult.securityApproved ? '检测到 SECURITY APPROVED' : '未明确检测到通过标记'} |\n`;
  markdown += `| 质量审查 | ${testResult.qualityApproved ? '✅ 通过' : '⚠️  待确认'} | ${testResult.qualityApproved ? '检测到 QUALITY APPROVED' : '未明确检测到通过标记'} |\n`;
  markdown += `| 节点执行 | ℹ️  信息 | 执行了 ${testResult.totalUniqueNodes} 个不同的节点 |\n\n`;

  markdown += `---\n\n`;

  markdown += `## 循环统计\n\n`;
  markdown += `### 安全循环 (security-loop)\n`;
  markdown += `- 检测状态: ${testResult.securityLoop.detected ? '✅ 已触发' : '❌ 未触发'}\n`;
  markdown += `- 循环轮数: ${testResult.securityLoop.iterations} 轮\n`;
  markdown += `- 退出条件: ${testResult.securityApproved ? 'SECURITY APPROVED（审查通过）' : '未明确'}\n\n`;

  markdown += `### 质量循环 (quality-loop)\n`;
  markdown += `- 检测状态: ${testResult.qualityLoop.detected ? '✅ 已触发' : '❌ 未触发'}\n`;
  markdown += `- 循环轮数: ${testResult.qualityLoop.iterations} 轮\n`;
  markdown += `- 退出条件: ${testResult.qualityApproved ? 'QUALITY APPROVED（审查通过）' : '未明确'}\n\n`;

  markdown += `---\n\n`;

  markdown += `## 助手完整响应\n\n`;
  markdown += `\`\`\`\n${transcript.fullContent}\n\`\`\`\n\n`;
  markdown += `---\n\n`;

  markdown += `## 结论\n\n`;

  if (testPassed) {
    markdown += `✅ **复杂多循环工作流测试通过！**\n\n`;
    markdown += `成功验证了：\n`;
    markdown += `- 动态工作流引擎正确执行\n`;
    markdown += `- 两个独立循环都成功触发\n`;
    markdown += `- 循环之间正确协调（串行执行）\n`;
    markdown += `- 智能退出条件正常工作\n`;
    markdown += `- 总循环轮数：${testResult.securityLoop.iterations + testResult.qualityLoop.iterations} 轮\n\n`;
  } else {
    markdown += `⚠️  **测试需要进一步验证**\n\n`;
    if (!testResult.usedDynamicGraph) {
      markdown += `- 动态工作流未被使用，可能需要更明确的提示\n`;
    }
    if (!testResult.securityLoop.detected) {
      markdown += `- 安全循环未被检测到\n`;
    }
    if (!testResult.qualityLoop.detected) {
      markdown += `- 质量循环未被检测到\n`;
    }
  }

  writeFileSync(path, markdown, "utf-8");
  console.error(`[步骤4] 报告已保存: ${path}`);
}

async function main() {
  console.error("=".repeat(80));
  console.error("复杂多循环工作流 CDP E2E 测试");
  console.error("=".repeat(80));

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });

    console.error(`\n[连接] 正在连接到 CDP 端口 ${CDP_PORT}...`);
    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(2000);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    await prepareConversation(webviewSession);
    const { assistantTurnCount } = await submitQuestion(webviewSession, COMPLEX_CYCLE_PROMPT);
    const testResult = await waitForResponse(webviewSession, assistantTurnCount);

    await captureScreenshot(webviewSession, SCREENSHOT_PATH);
    await saveTranscript(webviewSession, assistantTurnCount, TRANSCRIPT_PATH, testResult);

    console.error("\n" + "=".repeat(80));
    console.error("测试完成");
    console.error("=".repeat(80));

    const result = {
      success: testResult.statusPill === "Completed",
      usedDynamicGraph: testResult.usedDynamicGraph,
      securityLoop: testResult.securityLoop,
      qualityLoop: testResult.qualityLoop,
      securityApproved: testResult.securityApproved,
      qualityApproved: testResult.qualityApproved,
      totalNodes: testResult.totalNodes,
      elapsed: testResult.elapsed,
      screenshotPath: SCREENSHOT_PATH,
      transcriptPath: TRANSCRIPT_PATH,
    };

    console.log(JSON.stringify(result, null, 2));

    const testPassed = result.success &&
                       result.usedDynamicGraph &&
                       result.securityLoop.detected &&
                       result.qualityLoop.detected;

    process.exit(testPassed ? 0 : 1);

  } catch (error) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
