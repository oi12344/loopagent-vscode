import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { createTreeSitterParserRuntime } from "../../src/extension/intelligence/parser/treeSitterRuntime";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

describe("createTreeSitterParserRuntime", () => {
  it("parses TypeScript with a real tree", async () => {
    const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });

    const parsed = await runtime.parse("src/a.ts", "typescript", "export function run() { return 1; }");

    expect(parsed.tree).toBeTruthy();
    expect(parsed.diagnostics).toEqual([]);
    parsed.tree?.delete();
  });

  it("parses Python with a real tree", async () => {
    const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });

    const parsed = await runtime.parse("app/service.py", "python", "def run():\n    return 1\n");

    expect(parsed.tree).toBeTruthy();
    expect(parsed.diagnostics).toEqual([]);
    parsed.tree?.delete();
  });

  it("degrades unsupported languages without throwing", async () => {
    const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });

    const parsed = await runtime.parse("README.md", "markdown", "# title");

    expect(parsed.tree).toBeUndefined();
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ severity: "warning" })]);
  });
});
