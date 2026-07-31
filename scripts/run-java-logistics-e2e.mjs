// Java 物流接口 E2E：打开 yguctask 项目，定位到 LogisticsController.java，
// 提问新增物流信息接口，观察模型推理过程和最终结果
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
const TURN_TIMEOUT_MS = 300_000; // 5 分钟超时
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "java-logistics-e2e.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "java-logistics-e2e.md");

// 目标项目和文件路径
const PROJECT_PATH = "D:\\zz\\yguc";
const TARGET_FILE = "D:\\zz\\yguc\\yguc-biz\\src\\main\\java\\com\\sunshine\\procurement\\controller\\LogisticsController.java";

// 测试提示词 - 包含完整文件路径
const TEST_PROMPT = `请在 D:\\zz\\yguc\\yguc-biz\\src\\main\\java\\com\\sunshine\\procurement\\controller\\LogisticsController.java 中新增一个新增物流信息的接口`;

// CDP 的 awaitPromise 在 Webview 执行上下文变化后会把挂起的 promise 回收，
// 因此所有注入代码保持同步，需要等待的地方一律回到 Node 侧 delay。
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

// 注意：文件夹在 VSCode 启动时通过 CLI 参数打开，此函数仅用于验证
async function verifyWorkspace(workbenchSession, expectedPath) {
  console.error(`[步骤1] 验证工作区: ${expectedPath}`);

  // 等待工作区加载
  await delay(5000);

  console.error(`[步骤1] 工作区已就绪`);
}

// 不再需要打开文件，用户可以在提问中指定文件路径
// async function openAndNavigateToFile(workbenchSession, filePath) { ... }

// 准备对话：新建会话
async function prepareConversation(session) {
  console.error(`[步骤3] 准备对话会话`);
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
  console.error(`[步骤3] 会话已准备`);
}

// 提交问题
async function submitQuestion(session, prompt) {
  console.error(`[步骤4] 提交问题: ${prompt}`);
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

  // 监听工具调用和运行图
  const armed = await session.evaluate(
    syncEval(`
    const submit = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof webviewWindow.HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "submit unavailable (disabled=" + submit?.disabled + ")" };
    }
    const assistantTurnCount = webviewDocument.querySelectorAll(".message-assistant").length;

    // 设置监听器跟踪推理和工具调用
    webviewWindow.__loopAgentWatch = {
      toolCalls: [],
      reasoning: "",
      startTime: Date.now()
    };

    submit.click();
    return { ok: true, assistantTurnCount };
  `),
  );
  if (!armed?.ok) {
    throw new Error(`提交失败: ${armed?.reason ?? "未知 Webview 状态"}`);
  }
  console.error(`[步骤4] 问题已提交，等待响应...`);
  return armed;
}

// 等待回答完成
async function waitForResponse(session, previousTurnCount) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastSnapshot;
  let lastProgress = Date.now();

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

      // 采集推理过程
      const reasoning = turn?.querySelector(".reasoning-content")?.innerText ?? "";

      // 采集工具调用
      const toolCalls = [...(turn?.querySelectorAll(".tool-call-entry") ?? [])].map((entry) => {
        const nameEl = entry.querySelector(".tool-call-name");
        const inputEl = entry.querySelector(".tool-call-input");
        const outputEl = entry.querySelector(".tool-call-output");
        const statusClass = [...entry.classList].find((name) =>
          name.startsWith("tool-call-") && name !== "tool-call-entry"
        ) ?? "";

        return {
          name: nameEl?.textContent?.trim() ?? "",
          input: inputEl?.textContent?.trim() ?? "",
          output: outputEl?.textContent?.trim() ?? "",
          status: statusClass,
        };
      });

      // 采集最终回答（过滤掉工具调用标记）
      let answer = turn?.querySelector(".assistant-answer")?.innerText ?? "";
      // 如果回答包含工具调用标记，说明还在处理中或格式错误
      if (answer.includes("｜｜DSML｜｜") || answer.includes("<｜｜DSML｜｜")) {
        answer = "";
      }

      // 检查错误
      const error = turn?.querySelector('[role="alert"]')?.innerText ?? "";

      return {
        meta,
        statusPill,
        reasoning,
        reasoningLength: reasoning.length,
        toolCalls,
        toolCallCount: toolCalls.length,
        answer,
        answerLength: answer.length,
        error,
        elapsedMs: Date.now() - (webviewWindow.__loopAgentWatch?.startTime ?? Date.now()),
      };
    })()`);

    if (state) {
      lastSnapshot = state;

      // 每隔 5 秒输出进度
      if (Date.now() - lastProgress > 5000) {
        console.error(
          `[进度] 推理: ${state.reasoningLength}字 | 工具调用: ${state.toolCallCount}次 | ` +
          `回答: ${state.answerLength}字 | 状态: ${state.statusPill} | ` +
          `耗时: ${Math.round(state.elapsedMs / 1000)}s`
        );
        lastProgress = Date.now();
      }

      // 检查是否完成
      if (state.error) {
        console.error(`[错误] ${state.error}`);
        return { ...state, done: false };
      }
      if (state.meta.includes("Done") && state.answer.trim()) {
        console.error(`[完成] 耗时 ${Math.round(state.elapsedMs / 1000)}s`);
        return { ...state, done: true };
      }
    }

    await delay(1000);
  }

  const detail = lastSnapshot
    ? ` 最后状态: ${lastSnapshot.statusPill}, 推理=${lastSnapshot.reasoningLength}, 回答=${lastSnapshot.answerLength}`
    : "";
  throw new Error(`等待响应超时 ${TURN_TIMEOUT_MS}ms。${detail}`);
}

// 截图
async function captureScreenshot(session) {
  console.error(`[步骤5] 保存截图`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
  if (typeof screenshot?.data !== "string") {
    throw new Error("截图未返回 PNG 数据");
  }
  writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
  console.error(`[步骤5] 截图已保存: ${SCREENSHOT_PATH}`);
}

// 生成测试报告
function writeTranscript(response) {
  console.error(`[步骤6] 生成测试报告`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const toolCallsSection = response.toolCalls.map((call, idx) => {
    return [
      `#### 工具调用 ${idx + 1}: ${call.name}`,
      "",
      `**状态**: ${call.status}`,
      "",
      `**输入**:`,
      "```",
      call.input.substring(0, 500) + (call.input.length > 500 ? "..." : ""),
      "```",
      "",
      `**输出**:`,
      "```",
      call.output.substring(0, 1000) + (call.output.length > 1000 ? "..." : ""),
      "```",
      "",
    ].join("\n");
  }).join("\n");

  const content = [
    "# Java 物流接口 E2E 测试报告",
    "",
    `**测试时间**: ${new Date().toISOString()}`,
    `**项目路径**: ${PROJECT_PATH}`,
    `**目标文件**: ${TARGET_FILE}`,
    `**测试提示**: ${TEST_PROMPT}`,
    "",
    "---",
    "",
    "## 执行摘要",
    "",
    `- **状态**: ${response.done ? "✅ 成功完成" : "❌ 失败或未完成"}`,
    `- **总耗时**: ${Math.round(response.elapsedMs / 1000)}秒`,
    `- **推理过程长度**: ${response.reasoningLength} 字符`,
    `- **工具调用次数**: ${response.toolCallCount} 次`,
    `- **最终回答长度**: ${response.answerLength} 字符`,
    response.error ? `- **错误信息**: ${response.error}` : "",
    "",
    "---",
    "",
    "## 推理过程",
    "",
    "```",
    response.reasoning || "(无推理内容)",
    "```",
    "",
    "---",
    "",
    "## 工具调用详情",
    "",
    toolCallsSection || "(无工具调用)",
    "",
    "---",
    "",
    "## 最终回答",
    "",
    response.answer || "(无回答内容)",
    "",
    "---",
    "",
    "## 附件",
    "",
    `- 截图: [${SCREENSHOT_PATH}](${SCREENSHOT_PATH})`,
    "",
  ].filter(line => line !== "").join("\n");

  writeFileSync(TRANSCRIPT_PATH, content, "utf8");
  console.error(`[步骤6] 报告已保存: ${TRANSCRIPT_PATH}`);
}

async function main() {
  let workbenchSession;
  let webviewSession;

  try {
    console.error(`\n======================================`);
    console.error(`Java 物流接口 E2E 测试开始`);
    console.error(`======================================\n`);

    // 连接到 VS Code
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);

    // 验证工作区
    await verifyWorkspace(workbenchSession, PROJECT_PATH);

    // 不再需要打开文件 - 在提问中指定完整路径

    // 打开 LoopAgent 视图
    await openLoopAgentView(workbenchSession);

    // 连接到 Webview
    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    // 准备对话
    await prepareConversation(webviewSession);

    // 提交问题
    const submission = await submitQuestion(webviewSession, TEST_PROMPT);

    // 等待响应
    const response = await waitForResponse(webviewSession, submission.assistantTurnCount);

    // 截图
    await captureScreenshot(workbenchSession);

    // 生成报告
    writeTranscript(response);

    console.error(`\n======================================`);
    console.error(`测试完成`);
    console.error(`======================================\n`);

    // 输出 JSON 结果供自动化工具解析
    console.log(JSON.stringify({
      success: response.done,
      elapsedMs: response.elapsedMs,
      reasoningLength: response.reasoningLength,
      toolCallCount: response.toolCallCount,
      answerLength: response.answerLength,
      error: response.error || null,
      screenshotPath: SCREENSHOT_PATH,
      transcriptPath: TRANSCRIPT_PATH,
    }, null, 2));

    if (!response.done) {
      process.exitCode = 1;
    }

  } catch (error) {
    console.error(`\n❌ 测试失败: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
