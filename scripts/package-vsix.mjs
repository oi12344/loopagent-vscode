import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { assertVsixContents } = require("./vsixContents.js");
const { listSuperpowersResourcePaths } = require("./superpowersResources.js");

const root = resolve(import.meta.dirname, "..");
const artifactPath = resolve(root, ".artifacts", "loopagent-vscode-0.0.1.vsix");
const vscePath = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const vsceArgs = ["package", "--no-dependencies", "--out", artifactPath, ...process.argv.slice(2)];
const superpowersResourceRoot = resolve(root, "resources", "superpowers");
const requiredSuperpowersEntries = listSuperpowersResourcePaths(superpowersResourceRoot).map(
  (path) => `extension/resources/superpowers/${path}`,
);

await mkdir(resolve(root, ".artifacts"), { recursive: true });
rmSync(resolve(root, "dist"), { recursive: true, force: true });

const result = await new Promise((resolveExit, reject) => {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : vscePath;
  const args =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          `""${vscePath}" package --no-dependencies --out "${artifactPath}" ${process.argv.slice(2).join(" ")}"`,
        ]
      : vsceArgs;
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: process.platform === "win32",
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", reject);
  child.once("close", (exitCode, signal) => {
    resolveExit({ exitCode, signal, stdout, stderr });
  });
});

if (result.exitCode !== 0) {
  if (result.stdout) {
    process.stderr.write(result.stdout);
    if (!result.stdout.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
  process.stderr.write(
    `VSCE packaging failed (exitCode=${String(result.exitCode)}, signal=${result.signal ?? "none"})\n`,
  );
  process.exitCode = result.exitCode ?? 1;
} else {
  const entries = await assertVsixContents(artifactPath);
  const missingSuperpowersEntries = requiredSuperpowersEntries.filter(
    (entry) => !entries.includes(entry),
  );
  if (missingSuperpowersEntries.length > 0) {
    throw new Error(
      `VSIX is missing vendored Superpowers resources: ${JSON.stringify(missingSuperpowersEntries)}`,
    );
  }
  console.log(JSON.stringify({ artifactPath, entryCount: entries.length }));
}
