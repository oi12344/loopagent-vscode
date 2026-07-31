/**
 * 快速测试版本 - 3个文件，1分钟超时
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
const TURN_TIMEOUT_MS = 120_000; // 2 分钟超时（快速测试）
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "quick-workflow-test.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "quick-workflow-test.md");

// 快速测试提示 - 3个文件，强制工作流
const QUICK_PROMPT = `
🚨 **强制要求：必须使用 runDynamicGraph 工具！**

请并行分析以下 3 个核心文件的代码质量：

1. src/extension/agent/reactAgentRunner.ts
2. src/shared/chatTypes.ts
3. src/webview/App.tsx

## 任务要求

为每个文件提取：
- 主要导出的类型/函数
- 代码复杂度评估
- 潜在改进点

## 工作流结构

\`\`\`typescript
const nodes = [
  {
    nodeId: 'analyze-reactAgentRunner',
    role: 'code-analyzer',
    task: '分析 reactAgentRunner.ts',
  },
  {
    nodeId: 'analyze-chatTypes',
    role: 'code-analyzer',
    task: '分析 chatTypes.ts',
  },
  {
    nodeId: 'analyze-App',
    role: 'code-analyzer',
    task: '分析 App.tsx',
  },
];

// 立即使用 runDynamicGraph
runDynamicGraph({ initialNodes: nodes });
\`\`\`

**不要使用顺序处理，立即调用 runDynamicGraph 工具！**
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
  console.error(\`[步骤1] 提交快速测试任务...\`);
  console.error(\`[步骤1] 提示长度: \${prompt.length} 字符\`);
  const payload = JSON.stringify(prompt);

  const filled = await session.evaluate(
    syncEval(\`
    const textarea = webviewDocument.querySelector("#message-input");
    if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) {
      return { ok: false, reason: "textarea missing" };
    }
    const setter = Object.getOwnPropertyDescriptor(
      webviewWindow.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!setter) return { ok: false, reason: "textarea setter missing" };
    setter.call(textarea, \${payload});
    textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
    return { ok: true, length: textarea.value.length };
  \`),
  );
  if (!filled?.ok) {
    throw new Error(\`填充输入框失败: \${filled?.reason ?? "未知 Webview 状态"}\`);
  }
  await delay(400);

  const armed = await session.evaluate(
    syncEval(\`
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "submit unavailable (disabled=" + submit?.disabled + ")" };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;
    submit.click();
    return { ok: true, assistantTurnCount };
  \`),
  );
  if (!armed?.ok) {
    throw new Error(\`提交失败: \${armed?.reason ?? "未知 Webview 状态"}\`);
  }
  console.error(\`[步骤1] 任务已提交，等待响应...\`);
  return armed;
}

async function waitForResponse(session, previousTurnCount) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastSnapshot;
  let lastProgress = Date.now();

  while (Date.now() < deadline) {
    const state = await session.evaluate(\`(() => {
      const webviewDocument =
        document.getElementById("active-frame")?.contentDocument ?? document;
      const webviewWindow = webviewDocument.defaultView ?? window;
      const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
      if (turns.length <= \${previousTurnCount}) return null;

      const turn = turns.at(-1);
      const statusPill = webviewDocument.querySelector(".status-pill")?.textContent?.trim() ?? "";

      let reasoning = turn.innerText || "";
      let toolCallCount = 0;

      const toolSelectors = [".tool-call", "[class*='tool']", "[class*='execution']"];
      for (const selector of toolSelectors) {
        const calls = [...turn.querySelectorAll(selector)];
        if (calls.length > 0) {
          toolCallCount = calls.length;
          break;
        }
      }

      const fullText = turn.innerText || "";
      const usedDynamicWorkflow = fullText.includes("runDynamicGraph") || fullText.includes("动态工作流");

      return {
        statusPill,
        reasoningLength: reasoning.length,
        toolCallCount,
        answerLength: reasoning.length,
        usedDynamicWorkflow,
      };
    })()\`);

    if (!state) {
      await delay(1000);
      continue;
    }

    const now = Date.now();
    if (now - lastProgress > 5000 || JSON.stringify(state) !== lastSnapshot) {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(
        \`[进度] 推理: \${state.reasoningLength}字 | 工具: \${state.toolCallCount}次 | 工作流: \${state.usedDynamicWorkflow ? '✅' : '❌'} | 耗时: \${elapsed}s\`
      );
      lastProgress = now;
      lastSnapshot = JSON.stringify(state);
    }

    if (state.statusPill === "Ready" || state.statusPill === "Completed" || state.statusPill === "Error") {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(\`[完成] 耗时 \${elapsed}s\`);

      if (state.usedDynamicWorkflow) {
        console.error(\`\\n🎉 成功触发动态工作流！\`);
      } else {
        console.error(\`\\n⚠️  未触发动态工作流\`);
      }

      return state;
    }

    await delay(2000);
  }

  throw new Error(\`等待响应超时 \${TURN_TIMEOUT_MS}ms\`);
}

async function main() {
  console.error("=".repeat(60));
  console.error("快速工作流测试（3文件，2分钟）");
  console.error("=".repeat(60));

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });

    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(500); // 优化：减少等待时间

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    await webviewSession.send("Runtime.enable");

    // 提交任务
    const { assistantTurnCount } = await submitQuestion(webviewSession, QUICK_PROMPT);

    // 等待完成
    const finalState = await waitForResponse(webviewSession, assistantTurnCount);

    console.error("\\n" + "=".repeat(60));
    console.error("测试完成");
    console.error("=".repeat(60));

    const result = {
      success: true,
      reasoningLength: finalState.reasoningLength,
      toolCallCount: finalState.toolCallCount,
      usedDynamicWorkflow: finalState.usedDynamicWorkflow,
    };

    console.log(JSON.stringify(result, null, 2));

    process.exit(result.usedDynamicWorkflow ? 0 : 1);

  } catch (error) {
    console.error(\`\\n❌ 测试失败: \${error.message}\`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
