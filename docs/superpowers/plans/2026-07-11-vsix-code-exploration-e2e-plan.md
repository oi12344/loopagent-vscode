# VSIX 代码探索 E2E 稳定基线实施计划

> **面向 agentic worker：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务实施本计划。每个步骤使用复选框跟踪，所有行为变更严格执行 RED -> GREEN -> REFACTOR。

**目标：** 生成可重复打包、隔离安装并通过真实 DeepSeek 单轮代码探索验收的 LoopAgent VSIX 稳定基线。

**架构：** 生产构建继续由现有 esbuild 入口负责，`@vscode/vsce` 只负责封装 VSIX；独立清单验证器读取生成后的 ZIP 条目，证明运行产物存在且测试、源码、密钥和本地目录未进入安装包。PowerShell 启动器复用固定 VS Code 用户目录、扩展目录和 `9333` 端口；CDP runner 操作真实 Webview，并用纯函数语义判定器检查回答中的调用链锚点。

**技术栈：** TypeScript、Vitest、Node.js 22、PowerShell、`@vscode/vsce` 3.9.2、`yauzl` 3.2.1、VS Code CLI、Chrome DevTools Protocol、DeepSeek OpenAI-compatible API。

**关联规格：** `docs/superpowers/specs/2026-07-11-vsix-code-exploration-e2e-design.md`

---

## 文件职责

- `package.json`：公开稳定打包、隔离启动和真实 E2E 命令，锁定 VSIX 开发依赖。
- `package-lock.json`：记录 `@vscode/vsce` 与 `yauzl` 的精确依赖图。
- `.gitignore`：排除 `.artifacts/` 下的 VSIX、截图和机器日志。
- `.vscodeignore`：定义生产 VSIX 的源码与测试排除边界。
- `scripts/package-vsix.mjs`：清理旧 `dist`、创建固定产物目录、捕获本地 `vsce` 输出，并在打包后执行清单验证。
- `scripts/vsixContents.js`：读取 VSIX ZIP 条目并执行必需文件、敏感路径、source map 与开发文件规则；不负责构建。
- `scripts/start-vscode-vsix-e2e.ps1`：停止旧测试窗口、安装 VSIX，并用固定目录和端口启动唯一隔离窗口。
- `scripts/codeExplorationE2e.js`：保存固定问题和纯语义判定函数。
- `scripts/run-code-exploration-e2e.mjs`：通过 CDP 操作真实 Workbench/Webview、等待完成、截图并输出无密钥摘要。
- `test/vsixPackaging.test.ts`：覆盖 package scripts、ignore 规则、打包编排契约、VSIX 清单判定和损坏 ZIP 错误路径。
- `test/vscodeVsixE2eScript.test.ts`：覆盖隔离安装脚本的固定路径、安装参数和窗口约束。
- `test/codeExplorationE2e.test.ts`：覆盖语义锚点与路径判定，防止仅凭 `Done` 误报成功。
- `docs/development.md`：记录稳定 VSIX 的开发者命令和密钥边界。
- `docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-verification.md`：记录实际验证证据。

## Task 1：实现可重复 VSIX 打包和真实清单验证

**Files:**

- Create: `scripts/package-vsix.mjs`
- Create: `scripts/vsixContents.js`
- Create: `test/vsixPackaging.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `.vscodeignore`

- [ ] **Step 1：先写打包契约和清单判定测试**

创建 `test/vsixPackaging.test.ts`。测试只调用纯函数和读取配置，不在普通 `npm test` 中执行真实打包：

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { validateVsixEntries } = require("../scripts/vsixContents.js") as {
  validateVsixEntries(entries: string[]): { missing: string[]; forbidden: string[] };
};
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

describe("stable VSIX packaging", () => {
  it("uses pinned local packaging tools and repository commands", () => {
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

  it("ignores machine artifacts and source-only files", () => {
    const gitignore = readFileSync(resolve(process.cwd(), ".gitignore"), "utf8").split(/\r?\n/);
    const vscodeignore = readFileSync(resolve(process.cwd(), ".vscodeignore"), "utf8").split(/\r?\n/);

    expect(gitignore).toContain(".artifacts/");
    expect(vscodeignore).toEqual(expect.arrayContaining([
      "dist/test/**",
      "src/**",
      "scripts/**",
      "test/**",
      "docs/**",
      ".local-vscode-*/**",
      ".artifacts/**",
    ]));
  });

  it("accepts the complete production artifact list", () => {
    const result = validateVsixEntries([
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
    ]);

    expect(result).toEqual({ missing: [], forbidden: [] });
  });

  it("rejects missing runtime files and packaged tests or secrets", () => {
    const result = validateVsixEntries([
      "extension/package.json",
      "extension/dist/extension.js",
      "extension/dist/test/sqliteCapabilityExtension.test.js",
      "extension/test/providerRegistryCodeContext.test.ts",
      "extension/.env",
    ]);

    expect(result.missing).toContain("extension/dist/webview.js");
    expect(result.forbidden).toEqual(expect.arrayContaining([
      "extension/dist/test/sqliteCapabilityExtension.test.js",
      "extension/test/providerRegistryCodeContext.test.ts",
      "extension/.env",
    ]));
  });
});
```

测试还必须覆盖以下边界：

- `clientSecret.json`、`authToken.json`、`secrets.json`、`tokenValue.txt`、`.env*`、`api-key.json`、`api_key.json`、`apikey.json` 必须被拒绝。
- `tokenizer.js`、`secretary.md`、`api-keyboard.json` 和完整生产运行条目必须被接受。
- `extension/dist/**/*.map`、缺失运行文件、测试/源码/脚本/文档/本地目录必须被拒绝。
- `readVsixEntries` 对不存在和损坏的 ZIP 必须 reject，`assertVsixContents` 对损坏 ZIP 也必须 reject；不为这些测试增加新的 ZIP writer 依赖。
- 打包脚本契约必须证明打包前清理整个 `dist`、stdout/stderr 使用 pipe，并且失败时把捕获内容写入 stderr。

- [ ] **Step 2：运行测试确认 RED**

Run:

```powershell
npm test -- test/vsixPackaging.test.ts
```

Expected: FAIL，首先因为 `scripts/vsixContents.js` 不存在；创建空模块绕过导入后仍应因依赖、scripts 和 ignore 规则缺失而失败。不得先修改 `package.json`。

- [ ] **Step 3：实现最小清单验证器**

创建 `scripts/vsixContents.js`，保留两层接口：纯规则函数供 Vitest 使用，ZIP 读取函数供打包脚本使用。

```js
const yauzl = require("yauzl");

const REQUIRED_ENTRIES = [
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

const FORBIDDEN_PATH =
  /^extension\/(?:dist\/test|test|src|scripts|docs|\.local-vscode-[^/]*|\.artifacts)(?:\/|$)/i;
const FORBIDDEN_SOURCE_MAP = /^extension\/dist\/.*\.map$/i;
const SENSITIVE_TOKENS = new Set(["secret", "secrets", "token", "tokens", "apikey"]);

function normalizeEntry(entry) {
  return entry.replaceAll("\\", "/");
}

function hasSensitivePath(entry) {
  return entry.split("/").some((segment) => {
    if (segment.toLowerCase().startsWith(".env")) {
      return true;
    }

    const tokens = segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((token) => token.toLowerCase());

    return tokens.some(
      (token, index) =>
        SENSITIVE_TOKENS.has(token) || (token === "api" && tokens[index + 1] === "key"),
    );
  });
}

function validateVsixEntries(entries) {
  const normalizedEntries = entries.map(normalizeEntry);
  const entrySet = new Set(normalizedEntries);
  return {
    missing: REQUIRED_ENTRIES.filter((entry) => !entrySet.has(entry)),
    forbidden: normalizedEntries.filter(
      (entry) =>
        FORBIDDEN_PATH.test(entry) || FORBIDDEN_SOURCE_MAP.test(entry) || hasSensitivePath(entry),
    ),
  };
}

function readVsixEntries(vsixPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      zipFile.on("entry", (entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.once("error", reject);
      zipFile.once("end", () => resolve(entries));
      zipFile.readEntry();
    });
  });
}

async function assertVsixContents(vsixPath) {
  const entries = await readVsixEntries(vsixPath);
  const { missing, forbidden } = validateVsixEntries(entries);
  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `VSIX content validation failed: missing=${JSON.stringify(missing)} forbidden=${JSON.stringify(forbidden)}`,
    );
  }
  return entries;
}

module.exports = { assertVsixContents, readVsixEntries, validateVsixEntries };
```

- [ ] **Step 4：锁定依赖并增加打包配置**

Run:

```powershell
npm install --save-dev --save-exact @vscode/vsce@3.9.2 yauzl@3.2.1
```

Expected: `package.json` 与 `package-lock.json` 更新，两个 direct devDependency 都是不带 `^` 或 `~` 的精确版本。

在 `package.json` 增加：

```json
"package:vsix": "node scripts/package-vsix.mjs",
"start:vscode:vsix-e2e": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-vscode-vsix-e2e.ps1",
"test:e2e:code-exploration": "node scripts/run-code-exploration-e2e.mjs"
```

在 `.gitignore` 增加：

```gitignore
.artifacts/
```

把 `.vscodeignore` 扩展为以下精确发布边界：

```gitignore
.artifacts/**
.git/**
.github/**
.local-vscode-*/**
.vscode/**
.vscode-test/**
.worktrees/**
docs/**
scripts/**
src/**
test/**
dist/test/**
*.vsix
package-lock.json
tsconfig.json
vitest.config.ts
esbuild.js
```

- [ ] **Step 5：实现打包入口并执行真实 VSIX 验证**

创建 `scripts/package-vsix.mjs`：

```js
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
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
rmSync(resolve(root, "dist"), { recursive: true, force: true });

const result = await new Promise((resolveExit, reject) => {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : vscePath;
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `""${vscePath}" package --no-dependencies --out "${artifactPath}""`]
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
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (exitCode, signal) => {
    resolveExit({ exitCode, signal, stdout, stderr });
  });
});

if (result.exitCode !== 0) {
  if (result.stdout) {
    process.stderr.write(result.stdout);
    if (!result.stdout.endsWith("\n")) process.stderr.write("\n");
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith("\n")) process.stderr.write("\n");
  }
  process.stderr.write(
    `VSCE packaging failed (exitCode=${String(result.exitCode)}, signal=${result.signal ?? "none"})\n`,
  );
  process.exitCode = result.exitCode ?? 1;
} else {
  const entries = await assertVsixContents(artifactPath);
  console.log(JSON.stringify({ artifactPath, entryCount: entries.length }));
}
```

Run:

```powershell
npm test -- test/vsixPackaging.test.ts test/packageManifest.test.ts test/treeSitterAssets.test.ts
npm run compile
npm run package:vsix
```

Expected: 所有测试通过；普通 `npm run compile` 先生成 5 个 `.map`，随后打包入口删除整个 `dist` 并由 `vscode:prepublish` 重建 production；生成 `.artifacts/loopagent-vscode-0.0.1.vsix`，实际清单为 16 个合法条目、0 个 `.map`。成功时只输出 `artifactPath` 和 `entryCount`；失败时把捕获的 VSCE stdout/stderr 写到 stderr 并传播失败状态，不在成功路径输出 VSCE 文件列表或密钥。

Task 1 失败路径手动演练：临时让本地 `vsce.cmd` 不可用后运行打包入口，实际 exit code 为 1、stdout 为空、stderr 包含原始命令诊断和 `VSCE packaging failed` 摘要；演练结束后立即恢复 `vsce.cmd`，不保留临时日志。

- [ ] **Step 6：REFACTOR 并提交**

检查 `scripts/vsixContents.js` 只处理 ZIP 与规则，`scripts/package-vsix.mjs` 直接编排打包和失败诊断。失败格式化只有一个真实调用点，必须保持内联；不要增加 support module 或抽取跨脚本通用 CLI 框架。

Run:

```powershell
npm test -- test/vsixPackaging.test.ts test/packageManifest.test.ts test/treeSitterAssets.test.ts
npm run typecheck
git diff --check
```

Expected: 全部 exit code 0。

Commit:

```powershell
git add .gitignore .vscodeignore package.json package-lock.json scripts/package-vsix.mjs scripts/vsixContents.js test/vsixPackaging.test.ts
git diff --cached --check
git commit -m "build: add reproducible loopagent vsix"
```

## Task 2：实现唯一隔离 VSIX 安装窗口

**Files:**

- Create: `scripts/start-vscode-vsix-e2e.ps1`
- Create: `scripts/vscodeVsixE2eSupport.psm1`
- Create: `test/vscodeVsixE2eScript.test.ts`
- Modify: `docs/development.md`

质量复审发现初版仅按用户数据目录子串筛选进程，并把未引用的路径参数直接交给 `Start-Process -ArgumentList`。前者可能关闭相似路径或仅把目录作为 workspace 打开的普通窗口，后者在仓库路径含空格时会破坏参数边界。此外，`Stop-Process` 成功后再按 PID 调用 `Wait-Process` 存在目标已经从进程表消失的竞态，会把成功停止误报为等待失败；批量停止使用进程快照时，前序停止还可能让快照中的后续 PID 提前消失。本任务最终实现必须使用可执行测试覆盖精确参数匹配、Windows 标准参数 quoting、真实进程停止等待和多进程快照竞态，并让 CIM、权限、等待和残留检查的失败全部可见。

- [ ] **Step 1：先写隔离启动脚本契约测试**

创建 `test/vscodeVsixE2eScript.test.ts`：

测试除读取主脚本契约外，还必须通过子进程实际执行 PowerShell 并导入 `scripts/vscodeVsixE2eSupport.psm1`，验证三个含空格的启动路径参数、嵌入双引号与结尾反斜杠的 quoting，以及精确 `--user-data-dir=<path>` 参数的正反边界。测试还要启动隐藏的临时 PowerShell `Start-Sleep` 进程，调用生产 helper 后刷新原 process object 并断言 `HasExited`；多进程用例按“存活 PID、已提前退出 PID、存活 PID”的快照顺序调用 helper，证明中间 missing PID 不阻断后续停止。独立 missing PID 调用必须 exit 0。不得用注释或仅匹配 helper 名称代替可执行行为测试。

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("VSIX E2E launcher", () => {
  const script = readFileSync(resolve(process.cwd(), "scripts/start-vscode-vsix-e2e.ps1"), "utf8");

  it("installs the built VSIX into the fixed isolated extension directory", () => {
    expect(script).toContain('".artifacts\\loopagent-vscode-0.0.1.vsix"');
    expect(script).toContain('".local-vscode-user-data"');
    expect(script).toContain('".local-vscode-extensions"');
    expect(script).toContain('"--install-extension"');
    expect(script).toContain('"--force"');
  });

  it("opens the repository on port 9333 without development-path loading", () => {
    expect(script).toContain("$debugPort = 9333");
    expect(script).toContain('"--remote-debugging-port=$debugPort"');
    expect(script).toContain('"$projectRoot"');
    expect(script).not.toContain("--extensionDevelopmentPath");
  });

  it("stops an existing project test window before launch", () => {
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Stop-Process");
    expect(script).toContain("$escapedUserDataDir");
  });
});
```

- [ ] **Step 2：运行测试确认 RED**

Run:

```powershell
npm test -- test/vscodeVsixE2eScript.test.ts
```

Expected: FAIL，因为 `scripts/start-vscode-vsix-e2e.ps1` 不存在。

- [ ] **Step 3：实现固定目录安装和启动脚本**

创建 `scripts/start-vscode-vsix-e2e.ps1`。脚本必须：

```powershell
param(
  [switch]$KeepExisting
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "vscodeVsixE2eSupport.psm1") -Force -ErrorAction Stop
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$vsixPath = Join-Path $projectRoot ".artifacts\loopagent-vscode-0.0.1.vsix"
$userDataDir = Join-Path $projectRoot ".local-vscode-user-data"
$extensionsDir = Join-Path $projectRoot ".local-vscode-extensions"
$debugPort = 9333

if (-not (Test-Path -LiteralPath $vsixPath)) {
  throw "未找到 VSIX。请先运行 npm run package:vsix。"
}

function Find-CodeCli {
  $command = Get-Command code -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { return $command.Path }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "未找到 VS Code CLI。"
}

function Get-ExistingLoopAgentVsixProcesses {
  return @(
    Get-CimInstance Win32_Process -Filter "name = 'Code.exe'" -ErrorAction Stop |
      Where-Object { Test-VsixE2eProcessCommandLine $_.CommandLine $userDataDir }
  )
}

if (-not $KeepExisting) {
  $processes = @(Get-ExistingLoopAgentVsixProcesses)
  foreach ($process in $processes) {
    Stop-VsixE2eProcess -TargetProcessId $process.ProcessId -TimeoutSeconds 10 | Out-Null
  }
  $remainingProcesses = @(Get-ExistingLoopAgentVsixProcesses)
  if ($remainingProcesses.Count -gt 0) {
    throw "VSIX E2E process remained after termination"
  }
}

New-Item -ItemType Directory -Force -Path $userDataDir, $extensionsDir | Out-Null
$codeCli = Find-CodeCli
& $codeCli "--user-data-dir" $userDataDir "--extensions-dir" $extensionsDir "--install-extension" $vsixPath "--force"
if ($LASTEXITCODE -ne 0) { throw "VSIX 安装失败，exit code: $LASTEXITCODE" }

$args = @(
  "--new-window",
  (ConvertTo-WindowsCommandLineArgument "--user-data-dir=$userDataDir"),
  (ConvertTo-WindowsCommandLineArgument "--extensions-dir=$extensionsDir"),
  "--remote-debugging-port=$debugPort",
  "--disable-workspace-trust",
  (ConvertTo-WindowsCommandLineArgument "$projectRoot")
)
Start-Process -FilePath $codeCli -ArgumentList $args -WindowStyle Hidden
Write-Host "已启动单一 LoopAgent VSIX E2E 窗口。"
Write-Host "user-data-dir: $userDataDir"
Write-Host "extensions-dir: $extensionsDir"
Write-Host "remote-debugging-port: $debugPort"
```

实现时允许为 `code.cmd` 的 Windows 启动行为增加最小兼容处理，但不得加入 `--extensionDevelopmentPath`，也不得创建带编号目录。

`scripts/vscodeVsixE2eSupport.psm1` 只导出三个聚焦接口：纯函数 `ConvertTo-WindowsCommandLineArgument` 使用标准 Windows quoting 算法处理空白、嵌入双引号和结尾反斜杠；纯函数 `Test-VsixE2eProcessCommandLine` 仅接受大小写不敏感、独立且完整的 `--user-data-dir=<exact path>` 参数；`Stop-VsixE2eProcess` 使用 `Stop-Process -PassThru` 保存目标 process object，再通过 `Wait-Process -InputObject` 等待同一对象，避免按 PID 二次查找竞态。

`Stop-VsixE2eProcess` 只把 `FullyQualifiedErrorId` 为 `NoProcessFoundForGivenId*` 的停止错误视为目标已退出并幂等返回；权限错误、其他 `ProcessCommandException` 和等待超时必须原样抛出。默认停止流程使用精确谓词完成初次和停止后复查，最终残留复查是批量快照竞态后的安全条件；`KeepExisting` 必须继续跳过整段停止与复查流程。

```powershell
function Stop-VsixE2eProcess {
  param([int]$TargetProcessId, [int]$TimeoutSeconds = 10)

  try {
    $process = Stop-Process -Id $TargetProcessId -Force -PassThru -ErrorAction Stop
  } catch {
    if ($_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId*") {
      return
    }
    throw
  }

  Wait-Process -InputObject $process -Timeout $TimeoutSeconds -ErrorAction Stop
  return $process
}
```

- [ ] **Step 4：GREEN、文档同步与提交**

Run:

```powershell
npm test -- test/vscodeVsixE2eScript.test.ts test/vscodeDebugScript.test.ts test/vsixPackaging.test.ts
```

Expected: 全部通过，且原有 `npm run debug:vscode` 契约没有回归。

质量复审修复还必须运行全量 `npm test`、`npm run typecheck`、主脚本与 helper module 的 PowerShell AST 解析，以及 `git diff --check`。精确匹配与 quoting 修复提交使用 `fix(test): isolate vsix e2e launch`；同一 process object 等待修复提交使用 `fix(test): wait for stopped vscode process`；快照 missing PID 幂等修复提交使用 `fix(test): tolerate exited vscode snapshot process`，均不得 amend 初版提交。

更新 `docs/development.md`，增加：

````markdown
## 稳定 VSIX E2E

生产安装包验证使用固定入口：

```powershell
npm run package:vsix
npm run start:vscode:vsix-e2e
```

该流程把 `.artifacts/loopagent-vscode-0.0.1.vsix` 安装到 `.local-vscode-extensions`，并复用 `.local-vscode-user-data` 和端口 `9333`。启动参数不包含 `--extensionDevelopmentPath`，因此验证对象是安装后的 VSIX。真实 DeepSeek 验证可由启动进程临时继承 `DEEPSEEK_API_KEY`，脚本和验证记录不得输出密钥值。
````

Commit:

```powershell
git add scripts/start-vscode-vsix-e2e.ps1 test/vscodeVsixE2eScript.test.ts docs/development.md
git diff --cached --check
git commit -m "test: launch isolated loopagent vsix"
```

## Task 3：实现真实 Webview 代码探索判定与 CDP runner

**Files:**

- Create: `scripts/codeExplorationE2e.js`
- Create: `scripts/run-code-exploration-e2e.mjs`
- Create: `test/codeExplorationE2e.test.ts`
- Modify: `docs/development.md`

- [ ] **Step 1：先写语义判定 RED 测试**

创建 `test/codeExplorationE2e.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { CODE_EXPLORATION_QUESTION, evaluateCodeExploration } = require("../scripts/codeExplorationE2e.js") as {
  CODE_EXPLORATION_QUESTION: string;
  evaluateCodeExploration(result: { process: string; answer: string }): {
    passed: boolean;
    matchedAnchors: string[];
    matchedPaths: string[];
    missingStates: string[];
  };
};

describe("code exploration E2E oracle", () => {
  it("asks from one entry symbol without leaking downstream anchors", () => {
    expect(CODE_EXPLORATION_QUESTION).toContain("LoopAgentChatViewProvider.startRun");
    expect(CODE_EXPLORATION_QUESTION).not.toContain("createConfiguredAgentRunner");
    expect(CODE_EXPLORATION_QUESTION).not.toContain("buildCodeIntelligencePrompt");
  });

  it("accepts a completed answer with three downstream anchors and two real paths", () => {
    const result = evaluateCodeExploration({
      process: "Building code context\nCalling DeepSeek deepseek-v4-flash\nDone",
      answer: [
        "src/extension.ts calls createConfiguredAgentRunner.",
        "src/extension/model/providerRegistry.ts uses systemPromptProvider.",
        "It then invokes buildCodeIntelligencePrompt for the task.",
      ].join("\n"),
    });

    expect(result.passed).toBe(true);
    expect(result.matchedAnchors).toHaveLength(3);
    expect(result.matchedPaths).toHaveLength(2);
  });

  it("rejects Done-only, generic, or one-path answers", () => {
    const result = evaluateCodeExploration({
      process: "Calling DeepSeek deepseek-v4-flash\nDone",
      answer: "createConfiguredAgentRunner calls systemPromptProvider and buildCodeIntelligencePrompt.",
    });

    expect(result.passed).toBe(false);
    expect(result.missingStates).toContain("Building code context");
    expect(result.matchedPaths).toHaveLength(0);
  });
});
```

- [ ] **Step 2：运行测试确认 RED**

Run:

```powershell
npm test -- test/codeExplorationE2e.test.ts
```

Expected: FAIL，因为 `scripts/codeExplorationE2e.js` 不存在。

- [ ] **Step 3：实现纯语义判定器并确认 GREEN**

创建 `scripts/codeExplorationE2e.js`：

```js
const CODE_EXPLORATION_QUESTION =
  "追踪 LoopAgentChatViewProvider.startRun 到生成代码语义上下文的调用链，并说明工作区源码缓存何时失效。请列出关键源码文件和函数。";

const REQUIRED_STATES = ["Building code context", "Calling DeepSeek deepseek-v4-flash", "Done"];
const ANCHORS = [
  "createConfiguredAgentRunner",
  "systemPromptProvider",
  "buildCodeIntelligencePrompt",
  "createVsCodeWorkspaceIntelligence",
  "sourceCache",
  "dirtyPaths",
  "watcher",
];
const PATH_PATTERN = /src\/(?:extension\.ts|extension\/[A-Za-z0-9_./-]+\.ts)/g;

function evaluateCodeExploration({ process, answer }) {
  const missingStates = REQUIRED_STATES.filter((state) => !process.includes(state));
  const matchedAnchors = [...new Set(ANCHORS.filter((anchor) => answer.includes(anchor)))];
  const matchedPaths = [...new Set(answer.match(PATH_PATTERN) ?? [])];
  const hasRequiredIntelligencePath = matchedPaths.some((path) =>
    path === "src/extension/model/providerRegistry.ts" ||
    path === "src/extension/intelligence/vscodeWorkspaceIntelligence.ts",
  );
  return {
    passed: missingStates.length === 0 && matchedAnchors.length >= 3 && matchedPaths.length >= 2 && hasRequiredIntelligencePath,
    matchedAnchors,
    matchedPaths,
    missingStates,
  };
}

module.exports = { CODE_EXPLORATION_QUESTION, evaluateCodeExploration };
```

Run:

```powershell
npm test -- test/codeExplorationE2e.test.ts
```

Expected: 3 tests PASS。

- [ ] **Step 4：实现 CDP runner**

创建 `scripts/run-code-exploration-e2e.mjs`，使用 Node 22 内置 `fetch` 和 `WebSocket`，不得增加浏览器自动化依赖：

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { CODE_EXPLORATION_QUESTION, evaluateCodeExploration } = require("./codeExplorationE2e.js");
const root = resolve(import.meta.dirname, "..");
const CDP_PORT = 9333;
const WAIT_TIMEOUT_MS = 120_000;
const SCREENSHOT_PATH = resolve(root, ".artifacts", "code-exploration-e2e.png");

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  return response.json();
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)));
    else callbacks.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const callbacks of pending.values()) callbacks.reject(new Error("CDP socket closed"));
    pending.clear();
  });

  function send(method, params = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "CDP evaluation failed");
    return response.result?.value;
  }

  return { send, evaluate, close: () => socket.close() };
}

async function dispatchKey(session, type, key, code, virtualKeyCode, modifiers = 0) {
  await session.send("Input.dispatchKeyEvent", {
    type,
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
}

async function openFocusChatCommand(session) {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("Page.bringToFront");
  await dispatchKey(session, "rawKeyDown", "Control", "ControlLeft", 17, 2);
  await dispatchKey(session, "rawKeyDown", "Shift", "ShiftLeft", 16, 10);
  await dispatchKey(session, "rawKeyDown", "P", "KeyP", 80, 10);
  await dispatchKey(session, "keyUp", "P", "KeyP", 80, 10);
  await dispatchKey(session, "keyUp", "Shift", "ShiftLeft", 16, 2);
  await dispatchKey(session, "keyUp", "Control", "ControlLeft", 17);
  await delay(700);
  await session.send("Input.insertText", { text: "LoopAgent: Focus Chat" });
  await delay(300);
  await dispatchKey(session, "rawKeyDown", "Enter", "Enter", 13);
  await dispatchKey(session, "keyUp", "Enter", "Enter", 13);
  await delay(2_000);
}

async function findWebviewTarget() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const target = targets.find((candidate) => {
      const identity = `${candidate.title ?? ""} ${candidate.url ?? ""}`.toLowerCase();
      return candidate.webSocketDebuggerUrl &&
        !identity.includes("workbench.html") &&
        (identity.includes("vscode-webview") || identity.includes("loopagent"));
    });
    if (target) return target;
    await delay(500);
  }
  throw new Error("LoopAgent Webview CDP target not found");
}

async function submitQuestion(session, question) {
  await session.send("Runtime.enable");
  const payload = JSON.stringify(question);
  const submitted = await session.evaluate(`(async () => {
    const modelButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "DeepSeek v4 Flash");
    if (!modelButton) return { ok: false, reason: "model button missing" };
    modelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const modelItem = document.querySelector('[role="menuitem"][aria-label^="DeepSeek v4 Flash"]');
    modelItem?.click();
    const textarea = document.querySelector("#message-input");
    if (!(textarea instanceof HTMLTextAreaElement)) return { ok: false, reason: "textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${payload});
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const submit = document.querySelector('form.chat-composer button[type="submit"]');
    if (!(submit instanceof HTMLButtonElement) || submit.disabled) {
      return { ok: false, reason: "submit button unavailable" };
    }
    submit.click();
    return { ok: true };
  })()`);
  if (!submitted?.ok) throw new Error(`Could not submit code exploration question: ${submitted?.reason}`);
}

async function waitForAnswer(session) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await session.evaluate(`(() => {
      const turns = [...document.querySelectorAll(".message-assistant")];
      const turn = turns.at(-1);
      return {
        process: turn?.querySelector(".process-details")?.innerText ?? "",
        answer: turn?.querySelector(".assistant-answer")?.innerText ?? "",
        error: turn?.querySelector('[role="alert"]')?.innerText ?? "",
      };
    })()`);
    if (state?.error) throw new Error(`LoopAgent run failed: ${state.error}`);
    if (state?.process.includes("Done") && state.answer.trim()) return state;
    await delay(500);
  }
  throw new Error(`Timed out after ${WAIT_TIMEOUT_MS}ms waiting for LoopAgent`);
}

async function captureWorkbenchScreenshot(session) {
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}

const targets = await listTargets();
const workbench = targets.find((target) => String(target.url).includes("workbench.html"));
if (!workbench?.webSocketDebuggerUrl) throw new Error("VS Code workbench CDP target not found");

const workbenchSession = await connectCdp(workbench.webSocketDebuggerUrl);
let webviewSession;
try {
  await openFocusChatCommand(workbenchSession);
  const webviewTarget = await findWebviewTarget();
  webviewSession = await connectCdp(webviewTarget.webSocketDebuggerUrl);
  await submitQuestion(webviewSession, CODE_EXPLORATION_QUESTION);
  const result = await waitForAnswer(webviewSession);
  const evaluation = evaluateCodeExploration(result);
  await captureWorkbenchScreenshot(workbenchSession);
  console.log(JSON.stringify({
    passed: evaluation.passed,
    matchedAnchors: evaluation.matchedAnchors,
    matchedPaths: evaluation.matchedPaths,
    missingStates: evaluation.missingStates,
    answerLength: result.answer.length,
    screenshotPath: SCREENSHOT_PATH,
  }, null, 2));
  if (!evaluation.passed) process.exitCode = 1;
} finally {
  webviewSession?.close();
  workbenchSession.close();
}
```

runner 不读取、不记录、也不打印 `DEEPSEEK_API_KEY`。如果 Webview target 无 DOM，按 `testing-vscode-extension-e2e` 技能的顺序降级为 Workbench 坐标/键盘交互，并在验证记录中说明。

- [ ] **Step 5：静态安全检查、文档同步与提交**

在 `test/codeExplorationE2e.test.ts` 再增加：

```ts
it("does not read or print the DeepSeek secret", () => {
  const runner = readFileSync(resolve(process.cwd(), "scripts/run-code-exploration-e2e.mjs"), "utf8");
  expect(runner).not.toContain("DEEPSEEK_API_KEY");
  expect(runner).not.toContain("Authorization");
});
```

更新 `docs/development.md` 的稳定 VSIX E2E 小节，追加：

```powershell
Test-Path Env:DEEPSEEK_API_KEY
npm run start:vscode:vsix-e2e
npm run test:e2e:code-exploration
```

文档必须紧接着说明：存在性检查不会读取密钥值。若环境变量不存在，应在隔离窗口中执行 `LoopAgent: Set Model API Key`，由 VS Code SecretStorage 保存；不得把真实值写入 PowerShell history、仓库文件或验证记录。

Run:

```powershell
npm test -- test/codeExplorationE2e.test.ts test/vscodeVsixE2eScript.test.ts test/vsixPackaging.test.ts
npm run typecheck
git diff --check
```

Expected: 全部 exit code 0。

Commit:

```powershell
git add scripts/codeExplorationE2e.js scripts/run-code-exploration-e2e.mjs test/codeExplorationE2e.test.ts docs/development.md
git diff --cached --check
git commit -m "test: automate installed code exploration e2e"
```

## Task 4：执行完整稳定版验收并记录证据

**Files:**

- Create: `docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-verification.md`
- Modify: `docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-plan.md`
- Modify: `docs/superpowers/plans/2026-07-11-sqlite-index-storage-worker-plan.md`
- Modify: `scripts/run-sqlite-vscode-probe.mjs`
- Modify: `test/sqliteWorkerBundle.test.ts`

- [ ] **Step 1：运行确定性门禁**

Run:

```powershell
npm test
npm run typecheck
npm run package:vsix
npm run test:vscode:sqlite-probe
git diff --check
```

Expected:

- Vitest 报告 0 failed。
- TypeScript exit code 0。
- `.artifacts/loopagent-vscode-0.0.1.vsix` 生成且清单验证通过。
- SQLite probe 在 production package 清理 `dist` 后自行重建 worker 和 integration entry，不依赖普通开发构建残留。
- VS Code `1.103.0` / Node `v22.17.0` 的 sqlite、WAL、foreign keys、FTS5 全为 true。
- diff check exit code 0。

- [ ] **Step 2：确认真实密钥来源而不读取密钥值**

只执行存在性检查：

```powershell
Test-Path Env:DEEPSEEK_API_KEY
```

如果输出 `False`，在隔离 VS Code 窗口中执行 `LoopAgent: Set Model API Key` 写入 SecretStorage。不得运行会显示环境变量值的命令，不得把密钥作为命令行参数传递。

- [ ] **Step 3：启动唯一隔离窗口并确认加载来源**

Run:

```powershell
npm run start:vscode:vsix-e2e
Invoke-RestMethod http://127.0.0.1:9333/json/version
Invoke-RestMethod http://127.0.0.1:9333/json/list
```

Expected:

- 只存在一个使用 `.local-vscode-user-data` 的 LoopAgent 测试窗口。
- 工作区是当前仓库。
- Code 进程命令行不含 `--extensionDevelopmentPath`。
- CDP `9333` 可访问。
- 扩展列表显示安装后的 `local-dev.loopagent-vscode@0.0.1`。

- [ ] **Step 4：执行真实 DeepSeek 代码探索**

Run:

```powershell
npm run test:e2e:code-exploration
```

Expected: exit code 0；JSON 摘要中 `passed: true`、`matchedAnchors` 至少 3 项、`matchedPaths` 至少 2 项、`missingStates: []`、`answerLength` 大于 0，并生成 `.artifacts/code-exploration-e2e.png`。

如果 Webview DOM 不可访问，使用同一个窗口人工提交固定问题，并通过截图、可见 `Process` 状态和最终回答执行相同语义判定。不得启动第二个 VS Code 窗口。

- [ ] **Step 5：检查日志、进程和秘密泄漏**

检查固定用户目录下最新 Extension Host 日志：

```powershell
rg -n "Activating extension|tree-sitter|wasm|ERR|Error|Unhandled" .local-vscode-user-data/logs
git status --short
git diff --check
```

人工确认：

- 没有 LoopAgent 激活失败。
- 没有 Tree-sitter/WASM 资源缺失。
- 没有未处理异常。
- `.artifacts/` 和本地 VS Code 目录没有进入 Git status。
- 日志、截图和 Git diff 中没有 API Key 或 Authorization header。

完成后关闭唯一测试窗口；不要删除固定用户目录中的 SecretStorage，也不要创建额外临时用户目录。

- [ ] **Step 6：写中文验证记录**

创建 `docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-verification.md`，使用以下章节并填入本轮实际输出：

```markdown
# VSIX 代码探索 E2E 验证记录

## 验证对象

记录 commit、VS Code 版本、Extension Host Node 版本、VSIX 路径和扩展 ID。

## 确定性门禁

记录 Vitest 文件/用例数、typecheck、production build、VSIX 清单摘要和 SQLite probe 四项能力。

## 隔离安装

记录固定用户目录、扩展目录、端口、安装版本，以及进程命令行不含 `--extensionDevelopmentPath` 的证据。

## 真实代码探索

记录固定问题、可见过程状态、命中的语义锚点、命中的源码路径、回答长度和截图路径。只保留验收所需的回答摘要，不记录请求 header 或完整外部响应。

## 日志与安全检查

记录 Extension Host 错误检查、Git 状态和密钥泄漏检查结果。

## 已知限制

记录单轮请求、内存索引、无 Agent 搜索工具、SQLite 尚未接入索引等既有边界。
```

- [ ] **Step 7：更新计划状态并提交验证记录**

把本计划四个 Task 的复选框按实际执行结果改为已完成。若真实 DeepSeek 因鉴权、余额、限流或服务错误失败，保留未完成状态并记录实际错误，不得提交“通过”的验证记录。

Run:

```powershell
git diff --check
git status --short
```

Commit:

```powershell
git add docs/development.md docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-plan.md docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-verification.md
git diff --cached --check
git commit -m "docs: verify installed code exploration e2e"
```

## 最终清理与验收

完成 Task 4 后执行：

```powershell
npm test
npm run typecheck
npm run package:vsix
git diff --check
git status --short --branch
```

检查并删除本次实现产生的死文件、未使用导出、过期测试、调试输出和仓库内临时截图。`.artifacts/`、`.local-vscode-user-data/`、`.local-vscode-extensions/` 是明确忽略的本机验证资产，不提交到 Git。最终回复必须记录实际测试数量、VSIX 路径、真实 E2E 语义锚点、截图路径、限制和未解决问题。
