import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/start-vscode-vsix-e2e.ps1");
const supportModulePath = resolve(process.cwd(), "scripts/vscodeVsixE2eSupport.psm1");

function runPowerShell<T>(body: string): T {
  const output = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference = 'Stop'; Import-Module $env:VSIX_E2E_SUPPORT_MODULE -Force; ${body} | ConvertTo-Json -Compress`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        VSIX_E2E_SUPPORT_MODULE: supportModulePath,
      },
    },
  ).trim();

  return JSON.parse(output) as T;
}

describe("VS Code VSIX E2E support", () => {
  it("stops and waits for the same real process object", () => {
    const hasExited = runPowerShell<boolean>([
      "& {",
      "$child = Start-Process powershell -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru",
      "try {",
      "Stop-VsixE2eProcess -TargetProcessId $child.Id -TimeoutSeconds 5 | Out-Null",
      "$child.Refresh()",
      "$child.HasExited",
      "} finally {",
      "$child.Refresh()",
      "if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }",
      "}",
      "}",
    ].join("\n"));

    expect(hasExited).toBe(true);
  });

  it("surfaces a real stop failure for a missing process", () => {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Import-Module $env:VSIX_E2E_SUPPORT_MODULE -Force; Stop-VsixE2eProcess -TargetProcessId 2147483647 -TimeoutSeconds 1",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VSIX_E2E_SUPPORT_MODULE: supportModulePath,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("2147483647");
  });

  it("quotes all three launch path arguments that contain spaces", () => {
    const quoted = runPowerShell<string[]>(
      "@(ConvertTo-WindowsCommandLineArgument '--user-data-dir=E:\\A B\\.local-vscode-user-data'; " +
        "ConvertTo-WindowsCommandLineArgument '--extensions-dir=E:\\A B\\.local-vscode-extensions'; " +
        "ConvertTo-WindowsCommandLineArgument 'E:\\A B\\loopagent-vscode')",
    );

    expect(quoted).toEqual([
      '"--user-data-dir=E:\\A B\\.local-vscode-user-data"',
      '"--extensions-dir=E:\\A B\\.local-vscode-extensions"',
      '"E:\\A B\\loopagent-vscode"',
    ]);
  });

  it("uses standard Windows escaping for embedded quotes and trailing backslashes", () => {
    const quoted = runPowerShell<string[]>(
      String.raw`@(ConvertTo-WindowsCommandLineArgument '--path=A "quoted" value'; ConvertTo-WindowsCommandLineArgument 'E:\A B\ending\')`,
    );

    expect(quoted).toEqual([
      '"--path=A \\"quoted\\" value"',
      '"E:\\A B\\ending\\\\"',
    ]);
  });

  it("matches only the complete isolated user-data-dir argument", () => {
    const matches = runPowerShell<boolean[]>([
      "$target = 'E:\\A B\\.local-vscode-user-data'",
      "@(",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window \"--user-data-dir=E:\\A B\\.local-vscode-user-data\" \"E:\\A B\\loopagent-vscode\"' $target",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window \"--USER-DATA-DIR=E:\\A B\\.LOCAL-VSCODE-USER-DATA\"' $target",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window --user-data-dir=E:\\A B\\.local-vscode-user-data' $target",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window \"E:\\A B\\.local-vscode-user-data\"' $target",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window \"--user-data-dir=E:\\A B\\.local-vscode-user-data-extra\"' $target",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window \"--user-data-dir=E:\\A B\"' $target",
      "Test-VsixE2eProcessCommandLine 'Code.exe --new-window \"--user-data-dir-other=E:\\A B\\.local-vscode-user-data\"' $target",
      ")",
    ].join("; "));

    expect(matches).toEqual([true, true, false, false, false, false, false]);
  });
});

describe("VS Code VSIX E2E script", () => {
  const script = readFileSync(scriptPath, "utf8");

  it("installs the fixed VSIX into fixed isolated directories", () => {
    expect(script).toContain('".artifacts\\loopagent-vscode-0.0.1.vsix"');
    expect(script).toContain('".local-vscode-user-data"');
    expect(script).toContain('".local-vscode-extensions"');
    expect(script).toContain('"--install-extension"');
    expect(script).toContain('"--force"');
  });

  it("launches the project root on the fixed remote debugging port", () => {
    expect(script).toContain("$debugPort = 9333");
    expect(script).toContain('"--remote-debugging-port=$debugPort"');
    expect(script).toContain('"$projectRoot"');
  });

  it("never launches an extension development host", () => {
    expect(script).not.toContain("--extensionDevelopmentPath");
  });

  it("closes the existing isolated project window unless explicitly preserved", () => {
    expect(script).toContain("param(");
    expect(script).toContain("[switch]$KeepExisting");
    expect(script).toContain("Import-Module");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Test-VsixE2eProcessCommandLine");
    expect(script).toMatch(
      /Get-CimInstance Win32_Process[^\r\n]+-ErrorAction Stop/,
    );
    expect(script).toContain(
      "Stop-VsixE2eProcess -TargetProcessId $process.ProcessId -TimeoutSeconds 10 | Out-Null",
    );
    expect(script).not.toMatch(/Wait-Process\s+-Id/);
    expect(script).toContain("VSIX E2E process remained after termination");
    expect(script).not.toContain(
      "Get-CimInstance Win32_Process -Filter \"name = 'Code.exe'\" -ErrorAction SilentlyContinue",
    );
    expect(script).toContain("if (-not $KeepExisting)");
  });

  it("reports packaging guidance and propagates installation failures", () => {
    expect(script).toContain("npm run package:vsix");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toMatch(/if \(\$LASTEXITCODE -ne 0\)/);
    expect(script).toContain(
      'throw "VSIX installation failed, exit code: $LASTEXITCODE"',
    );
    expect(script).not.toContain('Write-Host "VSIX installation failed');
  });

  it("finds the Code CLI and launches an isolated new window", () => {
    expect(script).toContain("function Find-CodeCli");
    expect(script).toContain("Get-Command code -CommandType Application");
    expect(script).toContain("return $command.Path");
    expect(script).toContain("$env:LOCALAPPDATA");
    expect(script).toContain("$env:ProgramFiles");
    expect(script).toContain(
      'ConvertTo-WindowsCommandLineArgument "--user-data-dir=$userDataDir"',
    );
    expect(script).toContain(
      'ConvertTo-WindowsCommandLineArgument "--extensions-dir=$extensionsDir"',
    );
    expect(script).toContain(
      'ConvertTo-WindowsCommandLineArgument "$projectRoot"',
    );
    expect(script).toContain('"--new-window"');
    expect(script).toContain('"--disable-workspace-trust"');
    expect(script).toContain("Start-Process");
    expect(script).toContain("-WindowStyle Hidden");
  });
});
