// 用 mermaid 官方 parser 校验语法（GitHub 用的是同一个库）。
// 只 parse，不渲染，所以不需要 Chromium。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 24 的 globalThis.navigator 只有 getter，得用 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.DOMPurify = undefined;

const mermaid = (await import("mermaid")).default;
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

const dir = join(import.meta.dirname, "multiagent-series");
const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

let total = 0;
let failed = 0;

for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  if (blocks.length === 0) continue;

  for (const [index, match] of blocks.entries()) {
    total++;
    const code = match[1];
    const kind = code.trim().split(/\s|\n/)[0];
    try {
      await mermaid.parse(code);
      console.log(`  OK   ${file} #${index + 1} (${kind})`);
    } catch (error) {
      failed++;
      console.log(`  FAIL ${file} #${index + 1} (${kind})`);
      console.log(`       ${String(error.message ?? error).split("\n").slice(0, 6).join("\n       ")}`);
    }
  }
}

console.log(`\n${total} 个 mermaid 块，${failed} 个失败`);
process.exit(failed > 0 ? 1 : 0);
