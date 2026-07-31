/**
 * 复杂跨文件关联测试
 *
 * 测试场景：实现一个完整的 "代码审查报告生成" 功能
 * 涉及 6+ 个文件的协调修改，应该触发动态工作流
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
const TURN_TIMEOUT_MS = 600_000; // 10 分钟超时（复杂任务）
const ARTIFACT_DIR = resolve(root, ".artifacts");
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, "complex-multi-file-test.png");
const TRANSCRIPT_PATH = resolve(ARTIFACT_DIR, "complex-multi-file-test.md");

// 复杂的跨文件测试提示 - 明确要求使用动态工作流
const COMPLEX_PROMPT = `
请为以下 15 个核心文件添加完整的代码审查和质量检测功能。这是一个大规模并行任务，**必须使用 runDynamicGraph 动态工作流**来并行处理。

## 任务要求

### 阶段 1: 分析现有代码模式（并行）
对以下 15 个文件进行代码审查，提取：
1. 代码风格模式
2. 错误处理模式
3. 类型定义约定
4. 测试覆盖情况

**目标文件列表**：
1. src/extension/agent/reactAgentRunner.ts
2. src/extension/agent/reactTypes.ts
3. src/extension/agent/openAiReactModelTurn.ts
4. src/extension/agent/runCommandTool.ts
5. src/extension/agent/editPreviewService.ts
6. src/extension/agent/workflowOrchestrator.ts
7. src/extension/conversation/conversationManager.ts
8. src/extension/intelligence/workspaceIntelligence.ts
9. src/extension/intelligence/indexing/workspaceIndexer.ts
10. src/extension/intelligence/parser/treeSitterRuntime.ts
11. src/extension/model/openAiCompatibleClient.ts
12. src/extension/model/providerRegistry.ts
13. src/shared/chatTypes.ts
14. src/shared/messages.ts
15. src/webview/App.tsx

### 阶段 2: 生成审查报告（并行）
为每个文件生成：
- 代码质量评分
- 潜在问题列表
- 改进建议
- 测试覆盖缺口

### 阶段 3: 创建统一工具（串行）
基于分析结果，创建：
1. src/shared/chatTypes.ts - 添加 CodeReviewReport 类型
2. src/extension/agent/codeReviewTool.ts - 创建审查工具
3. test/codeReviewTool.test.ts - 添加测试

## 🚨 重要要求

**必须使用 runDynamicGraph 工具**！这个任务涉及 15 个文件的并行分析，使用动态工作流可以：
- 将分析时间从 5 分钟减少到 1 分钟
- 并行处理避免顺序等待
- 提供更好的进度可视化

## 预期工作流结构

\`\`\`typescript
// 阶段 1: 并行分析 15 个文件
const analysisNodes = files.map(file => ({
  nodeId: \`analyze-\${file}\`,
  role: 'code-analyzer',
  task: \`分析 \${file} 的代码质量\`,
  tools: ['readFile', 'grep'],
}));

// 阶段 2: 聚合结果
const aggregateNode = {
  nodeId: 'aggregate',
  role: 'synthesizer',
  task: '聚合所有分析结果，生成统一报告',
  dependencies: analysisNodes.map(n => n.nodeId),
};

// 使用 runDynamicGraph 执行
runDynamicGraph({
  initialNodes: analysisNodes,
  // ... 其他配置
});
\`\`\`

请立即开始使用 runDynamicGraph 处理这个大规模并行任务！
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
  console.error(`[步骤2] 提交复杂任务...`);
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

      // 采集推理和工具调用 - 使用更通用的选择器
      // 尝试多种可能的类名
      let reasoning = "";
      const thinkingSelectors = [".thinking-block", ".思考过程", "[class*='thinking']", "[class*='reasoning']"];
      for (const selector of thinkingSelectors) {
        const blocks = [...turn.querySelectorAll(selector)];
        if (blocks.length > 0) {
          reasoning = blocks.map(b => b.innerText).join("\\n");
          break;
        }
      }

      // 如果还是没有找到，尝试从整个 turn 的文本中提取
      if (!reasoning) {
        const turnText = turn.innerText || "";
        reasoning = turnText;
      }

      // 工具调用 - 尝试多种选择器
      let toolCallCount = 0;
      let usedDynamicWorkflow = false;
      const toolSelectors = [".tool-call", ".工具调用", "[class*='tool']", "[class*='execution-plan']"];
      for (const selector of toolSelectors) {
        const toolCalls = [...turn.querySelectorAll(selector)];
        if (toolCalls.length > 0) {
          toolCallCount = toolCalls.length;
          usedDynamicWorkflow = toolCalls.some(tc =>
            tc.innerText?.includes("runDynamicGraph") || tc.innerText?.includes("动态工作流")
          );
          break;
        }
      }

      // 从文本中检测动态工作流
      const fullText = turn.innerText || "";
      if (fullText.includes("runDynamicGraph") || fullText.includes("动态工作流")) {
        usedDynamicWorkflow = true;
      }

      const answerText = turn.querySelector(".message-content")?.innerText ?? turn.innerText ?? "";

      return {
        meta,
        statusPill,
        reasoning: reasoning.substring(0, 500),
        reasoningLength: reasoning.length,
        toolCallCount,
        answerLength: answerText.length,
        usedDynamicWorkflow,
      };
    })()`);

    if (!state) {
      await delay(1000);
      continue;
    }

    const now = Date.now();
    if (now - lastProgress > 5000 || JSON.stringify(state) !== lastSnapshot) {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(
        `[进度] 推理: ${state.reasoningLength}字 | 工具调用: ${state.toolCallCount}次 | 回答: ${state.answerLength}字 | 动态工作流: ${state.usedDynamicWorkflow ? '✅' : '❌'} | 耗时: ${elapsed}s`
      );
      lastProgress = now;
      lastSnapshot = JSON.stringify(state);
    }

    if (state.statusPill === "Completed" || state.statusPill === "Error") {
      const elapsed = Math.floor((now - (deadline - TURN_TIMEOUT_MS)) / 1000);
      console.error(`[完成] 耗时 ${elapsed}s`);

      if (state.usedDynamicWorkflow) {
        console.error(`[成功] ✅ 触发了动态工作流！`);
      } else {
        console.error(`[注意] ⚠️  未触发动态工作流`);
      }

      return state;
    }

    await delay(2000);
  }

  throw new Error(`等待响应超时 ${TURN_TIMEOUT_MS}ms。 最后状态: ${lastSnapshot}`);
}

async function captureScreenshot(session, path) {
  console.error(`[步骤3] 保存截图`);
  await session.send("Page.enable");
  const { data } = await session.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  writeFileSync(path, Buffer.from(data, "base64"));
  console.error(`[步骤3] 截图已保存: ${path}`);
}

async function saveTranscript(session, previousTurnCount, path) {
  console.error(`[步骤4] 生成测试报告`);

  const transcript = await session.evaluate(`(() => {
    const webviewDocument =
      document.getElementById("active-frame")?.contentDocument ?? document;
    const turns = [...webviewDocument.querySelectorAll(".message-assistant")];
    if (turns.length <= ${previousTurnCount}) return { turns: [] };

    const turn = turns.at(-1);

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

    // 提取工具调用 - 尝试多种选择器
    let toolCalls = [];
    const toolSelectors = [".tool-call", ".工具调用", "[class*='tool']", "[class*='execution']"];
    for (const selector of toolSelectors) {
      const calls = [...turn.querySelectorAll(selector)];
      if (calls.length > 0) {
        toolCalls = calls.map(tc => {
          const name = tc.querySelector(".tool-name")?.innerText ||
                       tc.querySelector("[class*='name']")?.innerText ||
                       "unknown";
          const status = tc.querySelector(".tool-status")?.innerText ||
                        tc.querySelector("[class*='status']")?.innerText ||
                        "unknown";
          const input = tc.querySelector(".tool-input")?.innerText || "";
          const output = tc.querySelector(".tool-output")?.innerText || "";
          return {
            name,
            status,
            input: input.substring(0, 500),
            output: output.substring(0, 500)
          };
        });
        break;
      }
    }

    const content = turn.querySelector(".message-content")?.innerText ?? turn.innerText ?? "";

    // 检测是否使用了动态工作流
    const fullText = turn.innerText || "";
    const usedDynamicWorkflow = fullText.includes("runDynamicGraph") ||
                                fullText.includes("动态工作流") ||
                                toolCalls.some(tc => tc.name.includes("runDynamicGraph"));

    return {
      reasoning,
      toolCalls,
      content,
      usedDynamicWorkflow,
    };
  })()`);

  let markdown = `# 复杂跨文件关联测试报告\n`;
  markdown += `**测试时间**: ${new Date().toISOString()}\n`;
  markdown += `**提示长度**: ${COMPLEX_PROMPT.length} 字符\n`;
  markdown += `**动态工作流**: ${transcript.usedDynamicWorkflow ? '✅ 已触发' : '❌ 未触发'}\n`;
  markdown += `---\n\n`;

  markdown += `## 用户请求\n`;
  markdown += `\`\`\`\n${COMPLEX_PROMPT}\n\`\`\`\n`;
  markdown += `---\n\n`;

  if (transcript.reasoning) {
    markdown += `## 推理过程\n`;
    markdown += `\`\`\`\n${transcript.reasoning}\n\`\`\`\n`;
    markdown += `---\n\n`;
  }

  if (transcript.toolCalls.length > 0) {
    markdown += `## 工具调用详情 (共 ${transcript.toolCalls.length} 次)\n\n`;
    transcript.toolCalls.forEach((call, idx) => {
      markdown += `#### 工具调用 ${idx + 1}: ${call.name}\n\n`;
      markdown += `**状态**: ${call.status}\n\n`;
      if (call.input) {
        markdown += `**输入**:\n\`\`\`\n${call.input}\n\`\`\`\n\n`;
      }
      if (call.output) {
        markdown += `**输出**:\n\`\`\`\n${call.output}\n\`\`\`\n\n`;
      }
    });
    markdown += `---\n\n`;
  }

  markdown += `## 最终回答\n`;
  markdown += `${transcript.content || '(无回答内容)'}\n`;
  markdown += `---\n\n`;

  markdown += `## 结论\n\n`;
  if (transcript.usedDynamicWorkflow) {
    markdown += `✅ **成功触发动态工作流！**\n\n`;
    markdown += `这证明了当任务足够复杂（6+ 个文件的跨文件修改）时，模型会选择使用动态工作流进行并行处理。\n`;
  } else {
    markdown += `⚠️  **未触发动态工作流**\n\n`;
    markdown += `可能的原因：\n`;
    markdown += `1. 模型认为任务可以通过顺序处理高效完成\n`;
    markdown += `2. 任务复杂度未达到触发阈值\n`;
    markdown += `3. 模型选择了其他优化策略\n`;
  }

  writeFileSync(path, markdown, "utf-8");
  console.error(`[步骤4] 报告已保存: ${path}`);

  return transcript;
}

async function main() {
  console.error("=".repeat(60));
  console.error("复杂跨文件关联测试开始");
  console.error("=".repeat(60));

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });

    // 连接到 VS Code Workbench
    const workbenchTarget = await findWorkbenchTarget(CDP_PORT);
    const workbenchSession = await connectCdp(workbenchTarget.webSocketDebuggerUrl);

    await openLoopAgentView(workbenchSession);
    await delay(2000);

    // 连接到 Webview
    const webviewTarget = await findWebviewTarget(CDP_PORT);
    const webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    // 准备会话
    await prepareConversation(webviewSession);

    // 提交复杂任务
    const { assistantTurnCount } = await submitQuestion(webviewSession, COMPLEX_PROMPT);

    // 等待完成
    const finalState = await waitForResponse(webviewSession, assistantTurnCount);

    // 截图
    await captureScreenshot(webviewSession, SCREENSHOT_PATH);

    // 保存报告
    const transcript = await saveTranscript(webviewSession, assistantTurnCount, TRANSCRIPT_PATH);

    console.error("\n" + "=".repeat(60));
    console.error("测试完成");
    console.error("=".repeat(60));

    const result = {
      success: finalState.statusPill === "Completed",
      reasoningLength: finalState.reasoningLength,
      toolCallCount: finalState.toolCallCount,
      answerLength: finalState.answerLength,
      usedDynamicWorkflow: transcript.usedDynamicWorkflow,
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
