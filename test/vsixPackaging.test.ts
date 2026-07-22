import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertVsixContents,
  readVsixEntries,
  validateVsixEntries,
} from "../scripts/vsixContents";
import { listSuperpowersResourcePaths } from "../scripts/superpowersResources";

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
        ".superpowers/**",
      ]),
    );
  });

  it("cleans dist and preserves failed VSCE diagnostics", () => {
    const packageScript = readFileSync(resolve(root, "scripts/package-vsix.mjs"), "utf8");

    expect(existsSync(resolve(root, "scripts/packageVsixSupport.js"))).toBe(false);
    expect(packageScript).toContain(
      'rmSync(resolve(root, "dist"), { recursive: true, force: true });',
    );
    expect(packageScript).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(packageScript).toContain("process.stderr.write(result.stdout)");
    expect(packageScript).toContain("process.stderr.write(result.stderr)");
  });

  it("requires every vendored Superpowers support file", () => {
    const packageScript = readFileSync(resolve(root, "scripts/package-vsix.mjs"), "utf8");

    expect(listSuperpowersResourcePaths(resolve(root, "resources", "superpowers"))).toContain(
      "skills/brainstorming/visual-companion.md",
    );
    expect(packageScript).toContain("listSuperpowersResourcePaths");
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
    "extension/dist/extension.js.map",
    "extension/dist/tree-sitter/parser.wasm.map",
  ])("rejects production source map %s", (sourceMapEntry) => {
    expect(validateVsixEntries([...requiredProductionEntries, sourceMapEntry])).toEqual({
      missing: [],
      forbidden: [sourceMapEntry],
    });
  });

  it.each([
    "extension/dist/test/probe.js",
    "extension/test/vsixPackaging.test.ts",
    "extension/src/extension.ts",
    "extension/scripts/package-vsix.mjs",
    "extension/docs/development.md",
    "extension/.env",
    "extension/.env.local",
    "extension/.envrc",
    "extension/.environment",
    "extension/config/secret.json",
    "extension/config/clientSecret.json",
    "extension/config/secrets.json",
    "extension/config/access-token.txt",
    "extension/config/authToken.json",
    "extension/config/tokenValue.txt",
    "extension/config/api-key.json",
    "extension/config/api_key.json",
    "extension/config/apikey.json",
    "extension/.local-vscode-user-data/User/settings.json",
    "extension/.artifacts/old.vsix",
  ])("rejects forbidden entry %s", (forbiddenEntry) => {
    expect(validateVsixEntries([...requiredProductionEntries, forbiddenEntry])).toEqual({
      missing: [],
      forbidden: [forbiddenEntry],
    });
  });

  it.each([
    "extension/dist/tokenizer.js",
    "extension/resources/secretary.md",
    "extension/resources/api-keyboard.json",
  ])("accepts non-sensitive entry %s", (entry) => {
    expect(validateVsixEntries([...requiredProductionEntries, entry])).toEqual({
      missing: [],
      forbidden: [],
    });
  });

  it("rejects missing and damaged VSIX files", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopagent-vsix-"));
    const missingPath = join(tempDirectory, "missing.vsix");
    const damagedPath = join(tempDirectory, "damaged.vsix");

    try {
      expect(existsSync(missingPath)).toBe(false);
      await expect(readVsixEntries(missingPath)).rejects.toThrow();

      writeFileSync(damagedPath, "not a zip archive");
      await expect(readVsixEntries(damagedPath)).rejects.toThrow();
      await expect(assertVsixContents(damagedPath)).rejects.toThrow();
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
