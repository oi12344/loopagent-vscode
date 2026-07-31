// 关联跨文件修改 E2E：先播种一个有真实耦合的模块（一个共享函数 + 4 个调用点），
// 再让真实模型改共享函数的签名。真正的验收不是"模型说改完了"，而是 tsc 编译通过——
// 漏掉任何一个调用点都会编译失败。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { connectCdp, findWebviewTarget, findWorkbenchTarget, openLoopAgentView, waitForCdp } from "./cdpClient.mjs";
import { runSingleTurn } from "./loopAgentDriver.mjs";

const CDP_PORT = 9333;
const ROOT = resolve(import.meta.dirname, "..");
const DIR_NAME = ".e2e-coupled-scratch";
const SCRATCH_DIR = resolve(ROOT, DIR_NAME);
const ARTIFACT_DIR = resolve(ROOT, ".artifacts");
const REPORT_PATH = resolve(ARTIFACT_DIR, "coupled-edit-e2e.json");

// 共享函数只有一个定义点，4 个调用点分散在 4 个文件里。
const SEED = {
  "tax.ts": `export function calculateTax(amount: number): number {
  return amount * 0.1;
}
`,
  "invoice.ts": `import { calculateTax } from "./tax.js";

export function invoiceTotal(amount: number): number {
  return amount + calculateTax(amount);
}
`,
  "receipt.ts": `import { calculateTax } from "./tax.js";

export function receiptLine(amount: number): string {
  return \`tax=\${calculateTax(amount)}\`;
}
`,
  "report.ts": `import { calculateTax } from "./tax.js";

export function reportTaxes(amounts: number[]): number {
  return amounts.reduce((sum, amount) => sum + calculateTax(amount), 0);
}
`,
  "summary.ts": `import { calculateTax } from "./tax.js";

export function summarize(amount: number): { net: number; tax: number } {
  return { net: amount, tax: calculateTax(amount) };
}
`,
};

const CALLER_FILES = ["invoice.ts", "receipt.ts", "report.ts", "summary.ts"];

const PROMPT =
  `工作区里有 ${DIR_NAME}/ 目录，其中 tax.ts 导出 calculateTax，税率 0.1 是硬编码的。` +
  "请把 calculateTax 改成接收第二个必填参数 rate: number，用这个参数代替硬编码的 0.1，" +
  "并把所有调用点都改成显式传入 0.1。" +
  `只允许修改 ${DIR_NAME}/ 目录下的文件，不要运行任何命令。`;

function seed() {
  if (existsSync(SCRATCH_DIR)) rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  for (const [name, content] of Object.entries(SEED)) {
    writeFileSync(resolve(SCRATCH_DIR, name), content, "utf8");
  }
  // 让 tsc 能独立编译这个目录，避免继承主 tsconfig 的 include/paths。
  writeFileSync(
    resolve(SCRATCH_DIR, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { strict: true, module: "Node16", moduleResolution: "Node16", target: "ES2022", noEmit: true }, include: ["*.ts"] },
      null,
      2,
    ),
    "utf8",
  );
}

function typecheck() {
  try {
    execFileSync("npx", ["tsc", "--project", resolve(SCRATCH_DIR, "tsconfig.json")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
  }
}

function inspect() {
  const read = (name) => readFileSync(resolve(SCRATCH_DIR, name), "utf8");
  const tax = read("tax.ts");
  const callers = CALLER_FILES.map((name) => {
    const content = read(name);
    // 只找单参调用：calculateTax(x) 后面没有逗号，说明这个调用点漏改了。
    const staleCall = /calculateTax\(\s*[A-Za-z0-9_.]+\s*\)/.test(content);
    return { file: name, passesRate: /calculateTax\([^)]*,[^)]*\)/.test(content), staleCall };
  });
  return {
    signatureUpdated: /function\s+calculateTax\s*\([^)]*rate\s*:\s*number/.test(tax),
    hardcodedRateRemoved: !/\*\s*0\.1/.test(tax),
    callers,
  };
}

async function main() {
  let workbenchSession;
  let webviewSession;
  try {
    seed();

    await waitForCdp(CDP_PORT);
    const workbench = await findWorkbenchTarget(CDP_PORT);
    workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
    await openLoopAgentView(workbenchSession);

    const webviewTarget = await findWebviewTarget(CDP_PORT);
    webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);

    const turn = await runSingleTurn(webviewSession, PROMPT);
    const checks = inspect();
    const compile = typecheck();

    const report = {
      prompt: PROMPT,
      toolCalls: turn.toolCalls,
      editCards: turn.editCards,
      answerLength: turn.answer.length,
      answer: turn.answer,
      ...checks,
      typecheckPassed: compile.ok,
      typecheckOutput: compile.output.slice(0, 2_000),
      allCallersUpdated: checks.callers.every((c) => c.passesRate && !c.staleCall),
    };
    report.passed =
      report.signatureUpdated && report.hardcodedRateRemoved && report.allCallersUpdated && report.typecheckPassed;

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    await Promise.allSettled([webviewSession?.close(), workbenchSession?.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
