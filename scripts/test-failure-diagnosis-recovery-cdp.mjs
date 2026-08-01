import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  connectCdp,
  delay,
  findWebviewTarget,
  findWorkbenchTarget,
  openLoopAgentView,
  waitForCdp,
} from "./cdpClient.mjs";

const root = resolve(import.meta.dirname, "..");
const port = 9333;
const turnTimeoutMs = 300_000;
const artifactPath = resolve(root, ".artifacts", "failure-diagnosis-recovery-cdp.json");

// Keep the failure deterministic: the node has no side effect and times out once,
// so the supervisor can diagnose it and publish a repaired result before summary.
const prompt = `
Call runDynamicGraph exactly once. Do not call another tool. Use this JSON without changing field names:
{
  "initialNodes": [
    {"id":"prepare","task":"Return exactly PREPARED and nothing else","role":"explorer","outputContract":{"exactText":"PREPARED"},"exportTo":"prepared"},
    {"id":"analysis-a","task":"Return exactly ANALYSIS_A_OK and nothing else","role":"explorer","dependsOn":["prepare"],"outputContract":{"exactText":"ANALYSIS_A_OK"}},
    {"id":"analysis-b","task":"Return exactly ANALYSIS_B_OK and nothing else","role":"explorer","dependsOn":["prepare"],"outputContract":{"exactText":"ANALYSIS_B_OK"}},
    {"id":"flaky-check","task":"This node intentionally times out. After the failure, recover this node with a new task that returns exactly FLAKY_CHECK_RECOVERED and nothing else. Do not inspect the workspace. Do not rerun prepare, analysis-a, or analysis-b.","role":"explorer","dependsOn":["analysis-a","analysis-b"],"timeoutMs":1,"retry":{"maxAttempts":1},"outputContract":{"exactText":"FLAKY_CHECK_RECOVERED"}},
    {"id":"summary","task":"Return exactly SUMMARY_OK and nothing else after the upstream nodes complete","role":"planner","dependsOn":["flaky-check"],"outputContract":{"exactText":"SUMMARY_OK"}}
  ],
  "maxNodes": 5,
  "maxExecutions": 10,
  "include": ["debug"]
}
The final answer must include the tool JSON and these fields: workflowStatus, statusCounts, completedNodes, failedNodes, unreachedNodes, recoveryDiagnostics, unresolvedFailures, and executionOrder. Explain why flaky-check failed, what recovery action was selected, and whether any successful upstream node was rerun.
The recovery planner must return a short reason, a replacement task, and timeoutMs:60000 so the repaired node can finish after the intentional 1ms timeout.
`;

function pickDocument() {
  return `const webviewDocument = document.getElementById("active-frame")?.contentDocument ?? document;
const webviewWindow = webviewDocument.defaultView;`;
}

function syncEval(body) {
  return `(() => { ${pickDocument()} if (!webviewWindow) return { ok: false, reason: "webview window missing" }; ${body} })()`;
}

function extractJson(text) {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1));
          if (value && typeof value === "object" && "workflowStatus" in value) return value;
        } catch {
          // Try the next balanced object; assistant output may contain snippets first.
        }
        break;
      }
    }
  }
  return undefined;
}

function extractLabeledReport(text) {
  const read = (field) => {
    const match = text.match(new RegExp(`(?:^|\\n)${field}:\\s*(.+)`));
    if (!match) return undefined;
    const value = match[1].trim();
    if (field === "workflowStatus") return value;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const report = {
    workflowStatus: read("workflowStatus"),
    statusCounts: read("statusCounts"),
    completedNodes: read("completedNodes"),
    failedNodes: read("failedNodes"),
    unreachedNodes: read("unreachedNodes"),
    recoveryDiagnostics: read("recoveryDiagnostics"),
    unresolvedFailures: read("unresolvedFailures"),
    executionOrder: read("executionOrder"),
  };
  return report.workflowStatus !== undefined ? report : undefined;
}

function validateResponse(text) {
  const requiredFields = [
    "workflowStatus",
    "statusCounts",
    "completedNodes",
    "failedNodes",
    "unreachedNodes",
    "recoveryDiagnostics",
    "unresolvedFailures",
    "executionOrder",
  ];
  const graph = extractJson(text) ?? extractLabeledReport(text);
  const hasFields = Boolean(graph && requiredFields.every((field) => field in graph));
  const completed = Array.isArray(graph?.completedNodes) ? graph.completedNodes : [];
  const order = Array.isArray(graph?.executionOrder) ? graph.executionOrder : [];
  const rerunUpstream = order.filter((id) => ["prepare", "analysis-a", "analysis-b"].includes(id)).length > 3;
  const diagnostics = Array.isArray(graph?.recoveryDiagnostics) ? graph.recoveryDiagnostics : [];
  const recovered = completed.includes("flaky-check") && completed.includes("summary");
  return {
    hasRunDynamicGraph: text.includes("runDynamicGraph"),
    hasFields,
    workflowStatus: graph?.workflowStatus,
    recovered,
    hasDiagnosis: diagnostics.length > 0 || /diagnos|recovery|恢复|诊断/i.test(text),
    rerunUpstream,
    reportFormat: extractJson(text) ? "json" : graph ? "labeled" : "missing",
    graph,
  };
}

async function submit(session) {
  const filled = await session.evaluate(syncEval(`
    const textarea = webviewDocument.querySelector("#message-input");
    if (!(textarea instanceof webviewWindow.HTMLTextAreaElement)) return { ok: false, reason: "textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(webviewWindow.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return { ok: false, reason: "textarea setter missing" };
    setter.call(textarea, ${JSON.stringify(prompt)});
    textarea.dispatchEvent(new webviewWindow.Event("input", { bubbles: true }));
    return { ok: true };
  `));
  if (!filled?.ok) throw new Error(`fill failed: ${filled?.reason ?? "unknown"}`);
  await delay(250);
  const submitted = await session.evaluate(syncEval(`
    const button = webviewDocument.querySelector('form.chat-composer button[type="submit"]');
    if (!(button instanceof webviewWindow.HTMLButtonElement) || button.disabled) return { ok: false, reason: "submit unavailable" };
    const count = webviewDocument.querySelectorAll(".message-assistant").length;
    button.click();
    return { ok: true, count };
  `));
  if (!submitted?.ok) throw new Error(`submit failed: ${submitted?.reason ?? "unknown"}`);
  return submitted.count;
}

async function waitForResponse(session, previousCount) {
  const deadline = Date.now() + turnTimeoutMs;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const document = globalThis.document.getElementById("active-frame")?.contentDocument ?? globalThis.document;
      const turns = [...document.querySelectorAll(".message-assistant")];
      if (turns.length <= ${previousCount}) return null;
      const turn = turns.at(-1);
      return {
        status: turn?.querySelector(".message-meta span:nth-child(2)")?.textContent?.trim() ?? "",
        text: turn?.innerText ?? "",
      };
    })()`);
    if (state && /^(Done|Error|Interrupted)$/i.test(state.status)) return state;
    await delay(1_000);
  }
  throw new Error(`response timeout after ${turnTimeoutMs}ms`);
}

async function run() {
  if (process.argv.includes("--dry-run")) {
    const validation = validateResponse(JSON.stringify({ workflowStatus: "completed", statusCounts: {}, completedNodes: [], failedNodes: [], unreachedNodes: [], recoveryDiagnostics: [], unresolvedFailures: [], executionOrder: [] }));
    console.log(JSON.stringify({ port, artifactPath, promptLength: prompt.length, validation, dryRun: true }, null, 2));
    return;
  }

  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  await waitForCdp(port);
  const workbench = await connectCdp((await findWorkbenchTarget(port)).webSocketDebuggerUrl);
  let webview;
  try {
    await openLoopAgentView(workbench);
    webview = await connectCdp((await findWebviewTarget(port)).webSocketDebuggerUrl);
    const previousCount = await submit(webview);
    const state = await waitForResponse(webview, previousCount);
    const result = { status: state.status, ...validateResponse(state.text), excerpt: state.text.slice(-2_000) };
    writeFileSync(artifactPath, JSON.stringify({ generatedAt: new Date().toISOString(), prompt, result }, null, 2), "utf8");
    console.log(JSON.stringify({ artifactPath, result }, null, 2));
    if (!result.hasRunDynamicGraph || !result.hasFields || !result.hasDiagnosis || !result.recovered || result.rerunUpstream) process.exitCode = 1;
  } finally {
    await Promise.allSettled([webview?.close(), workbench.close()]);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
