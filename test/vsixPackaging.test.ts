import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateVsixEntries } from "../scripts/vsixContents";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const requiredProductionEntries = [
  "extension/package.json",
  "extension/resources/loopagent.svg",
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  "extension/dist/sqliteIndexWorker.js",
  "extension/dist/tree-sitter/web-tree-sitter.wasm",
  "extension/dist/tree-sitter/tree-sitter-typescript.wasm",
  "extension/dist/tree-sitter/tree-sitter-tsx.wasm",
  "extension/dist/tree-sitter/tree-sitter-javascript.wasm",
  "extension/dist/tree-sitter/tree-sitter-python.wasm",
];

describe("VSIX packaging contract", () => {
  it("pins packaging dependencies and commands", () => {
    expect(manifest.devDependencies["@vscode/vsce"]).toBe("3.9.2");
    expect(manifest.devDependencies.yauzl).toBe("3.2.1");
    expect(manifest.scripts["package:vsix"]).toBe("node scripts/package-vsix.mjs");
    expect(manifest.scripts["start:vscode:vsix-e2e"]).toBe(
      "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-vscode-vsix-e2e.ps1",
    );
    expect(manifest.scripts["test:e2e:code-exploration"]).toBe(
      "node scripts/run-code-exploration-e2e.mjs",
    );
  });

  it("excludes artifacts and development-only paths", () => {
    const gitIgnoreLines = readFileSync(resolve(root, ".gitignore"), "utf8").split(/\r?\n/);
    expect(gitIgnoreLines).toContain(".artifacts/");

    const vscodeIgnoreLines = readFileSync(resolve(root, ".vscodeignore"), "utf8").split(/\r?\n/);
    expect(vscodeIgnoreLines).toEqual(
      expect.arrayContaining([
        "dist/test/**",
        "src/**",
        "scripts/**",
        "test/**",
        "docs/**",
        ".local-vscode-*/**",
        ".artifacts/**",
      ]),
    );
  });

  it("accepts the complete production payload", () => {
    expect(validateVsixEntries(requiredProductionEntries)).toEqual({
      missing: [],
      forbidden: [],
    });
  });

  it("reports missing runtime files", () => {
    const entries = requiredProductionEntries.filter(
      (entry) => entry !== "extension/dist/webview.js",
    );

    expect(validateVsixEntries(entries)).toEqual({
      missing: ["extension/dist/webview.js"],
      forbidden: [],
    });
  });

  it.each([
    "extension/dist/test/probe.js",
    "extension/test/vsixPackaging.test.ts",
    "extension/src/extension.ts",
    "extension/scripts/package-vsix.mjs",
    "extension/docs/development.md",
    "extension/.env",
    "extension/config/secret.json",
    "extension/config/access-token.txt",
    "extension/config/api-key.json",
    "extension/.local-vscode-user-data/User/settings.json",
    "extension/.artifacts/old.vsix",
  ])("rejects forbidden entry %s", (forbiddenEntry) => {
    expect(validateVsixEntries([...requiredProductionEntries, forbiddenEntry])).toEqual({
      missing: [],
      forbidden: [forbiddenEntry],
    });
  });
});
