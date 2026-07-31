// 上下文增长探针:跑 3 轮对话,每轮从 output channel 抓 messages 数组的实际字节数,
// 看 reasoning_content、tool 回复、历史消息累积是否让每轮 payload 不合理膨胀。

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { connectCdp, delay, findWebviewTarget, findWorkbenchTarget, openLoopAgentView, waitForCdp } from "./cdpClient.mjs";
import { submitPrompt, waitForTurn } from "./loopAgentDriver.mjs";

const CDP_PORT = 9333;
const ROOT = resolve(import.meta.dirname, "..");
const ARTIFACT_DIR = resolve(ROOT, ".artifacts");
const REPORT_PATH = resolve(ARTIFACT_DIR, "context-growth-probe-e2e.json");

// 3 轮依次递进的任务,每轮都需要读几个文件、写点代码或回答问题。
const TURNS = [
  "工作区里的 providerRegistry.ts 文件主要作用是什么?读一下然后简要回答 50 字内。",
  "那 conversationManager.ts 的核心职责是什么?同样 50 字内。",
  "前两个文件分别负责什么层?它们之间有直接调用关系吗?50 字内。",
];

const PICK_DOCUMENT = `
  const webviewDocument = document.getElementById("active-frame")?.contentDocument ?? document;
  const webviewWindow = webviewDocument.defaultView;
`;

async function newConversation(session) {
  await session.send("Runtime.enable");
  const started = await session.evaluate(`(() => {
    ${PICK_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window 缺失" };
    const newChat = [...webviewDocument.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(newChat instanceof webviewWindow.HTMLButtonElement)) return { ok: false, reason: "New chat 按钮缺失" };
    newChat.click();
    return { ok: true };
  })()`);
  if (!started?.ok) throw new Error(`新建会话失败: ${started?.reason}`);
  await delay(400);
}

async function readOutputChannel(workbenchSession) {
  // Output channel 内容在 workbench 的一个 webview 里,需要先打开面板再读取。
  // 为简化探针,直接用 CDP 在主窗口执行 command 触发显示,再读 DOM。
  await workbenchSession.send("Runtime.enable");
  const opened = await workbenchSession.evaluate(`(() => {
    // VS Code command palette 打开 output channel:vscode.commands.executeCommand("workbench.action.output.toggleOutput")
    // 更简单的是直接读 output service 的内存缓冲,但这需要 electron main 进程访问。
    // 绕过:让扩展自己把每轮 context 写到磁盘临时文件,这里读文件。
    // 但探针脚本本身不该改产品代码——先用占位,改成从 debug console 抓也行。
    return { ok: false, reason: "需从扩展侧协作暴露 output channel 内容" };
  })()`);
  // 当前实现:返回占位,实测时手动从 "LoopAgent - Model Context" output channel 复制粘贴。
  return { messagesLog: [] };
}

async function main() {
  let workbenchSession;
  let webviewSession;
  try {
    await waitForCdp(CDP_PORT);
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    await newConversation(webviewSession);
    await delay(600);

    const turns = [];
    let assistantTurnCount = 0;

    for (const [index, prompt] of TURNS.entries()) {
      console.log(`\n[Turn ${index + 1}/${TURNS.length}] "${prompt.slice(0, 60)}..."`);
      const submitted = await submitPrompt(webviewSession, prompt);
      assistantTurnCount = submitted.assistantTurnCount;
      const result = await waitForTurn(webviewSession, assistantTurnCount);

      // output channel 读取当前是占位,真实测试时从 VS Code UI 手动看"LoopAgent - Model Context"。
      // 这里用 DOM 统计 webview 里显示的数据作为下界。
      const domStats = await webviewSession.evaluate(`(() => {
        ${PICK_DOCUMENT}
        const allTurns = [...webviewDocument.querySelectorAll(".message-assistant, .message-user")];
        const userTurns = allTurns.filter(t => t.classList.contains("message-user"));
        const assistantTurns = allTurns.filter(t => t.classList.contains("message-assistant"));
        const totalText = allTurns.map(t => t.innerText ?? "").join("");
        return {
          userTurnCount: userTurns.length,
          assistantTurnCount: assistantTurns.length,
          totalCharsInDom: totalText.length,
        };
      })()`);

      turns.push({
        turnIndex: index + 1,
        prompt,
        toolCallCount: result.toolCalls.length,
        answerLength: result.answer.length,
        ...domStats,
      });
    }

    const report = {
      turns,
      note: "messagesLog from output channel requires manual inspection; DOM stats are lower bounds",
    };

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
