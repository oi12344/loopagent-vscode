import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { assertVsixContents } = require("./vsixContents.js");

const root = resolve(import.meta.dirname, "..");
const artifactPath = resolve(root, ".artifacts", "loopagent-vscode-0.0.1.vsix");
const vscePath = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const vsceArgs = ["package", "--no-dependencies", "--out", artifactPath];

await mkdir(resolve(root, ".artifacts"), { recursive: true });

const exitCode = await new Promise((resolveExit, reject) => {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : vscePath;
  const args =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          `""${vscePath}" package --no-dependencies --out "${artifactPath}""`,
        ]
      : vsceArgs;
  const child = spawn(command, args, {
    cwd: root,
    stdio: "ignore",
    windowsVerbatimArguments: process.platform === "win32",
  });

  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const entries = await assertVsixContents(artifactPath);
  console.log(JSON.stringify({ artifactPath, entryCount: entries.length }));
}
