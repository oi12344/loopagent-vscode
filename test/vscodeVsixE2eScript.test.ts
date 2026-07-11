import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/start-vscode-vsix-e2e.ps1");

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
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("$escapedUserDataDir");
    expect(script).toContain("Stop-Process");
    expect(script).toContain("if (-not $KeepExisting)");
  });

  it("reports packaging guidance and propagates installation failures", () => {
    expect(script).toContain("npm run package:vsix");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toMatch(/if \(\$LASTEXITCODE -ne 0\)/);
    expect(script).toMatch(/exit \$LASTEXITCODE/);
  });

  it("finds the Code CLI and launches an isolated new window", () => {
    expect(script).toContain("function Find-CodeCli");
    expect(script).toContain("Get-Command code");
    expect(script).toContain("$env:LOCALAPPDATA");
    expect(script).toContain("$env:ProgramFiles");
    expect(script).toContain('"--new-window"');
    expect(script).toContain('"--disable-workspace-trust"');
    expect(script).toContain("Start-Process");
    expect(script).toContain("-WindowStyle Hidden");
  });
});
