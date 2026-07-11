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

function Find-CodeCli {
  $command = Get-Command code -CommandType Application -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Path
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  throw "VS Code CLI was not found. Add code to PATH or install Visual Studio Code."
}

function Get-ExistingLoopAgentVsixProcesses {
  return @(
    Get-CimInstance Win32_Process -Filter "name = 'Code.exe'" -ErrorAction Stop |
    Where-Object {
      Test-VsixE2eProcessCommandLine $_.CommandLine $userDataDir
    }
  )
}

function Stop-ExistingLoopAgentVsixWindow {
  $processes = @(Get-ExistingLoopAgentVsixProcesses)

  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction Stop
  }

  $remainingProcesses = @(Get-ExistingLoopAgentVsixProcesses)
  if ($remainingProcesses.Count -gt 0) {
    $remainingProcessIds = $remainingProcesses.ProcessId -join ", "
    throw "VSIX E2E process remained after termination: $remainingProcessIds"
  }
}

if (-not (Test-Path -LiteralPath $vsixPath)) {
  throw "VSIX not found: $vsixPath. Run npm run package:vsix first."
}

if (-not $KeepExisting) {
  Stop-ExistingLoopAgentVsixWindow
}

New-Item -ItemType Directory -Force -Path $userDataDir, $extensionsDir | Out-Null

$codeCli = Find-CodeCli
$installArgs = @(
  "--user-data-dir",
  "$userDataDir",
  "--extensions-dir",
  "$extensionsDir",
  "--install-extension",
  "$vsixPath",
  "--force"
)

& $codeCli @installArgs
if ($LASTEXITCODE -ne 0) {
  throw "VSIX installation failed, exit code: $LASTEXITCODE"
}

$launchArgs = @(
  "--new-window",
  (ConvertTo-WindowsCommandLineArgument "--user-data-dir=$userDataDir"),
  (ConvertTo-WindowsCommandLineArgument "--extensions-dir=$extensionsDir"),
  "--remote-debugging-port=$debugPort",
  "--disable-workspace-trust",
  (ConvertTo-WindowsCommandLineArgument "$projectRoot")
)

Start-Process -FilePath $codeCli -ArgumentList $launchArgs -WindowStyle Hidden

Write-Host "Started the single LoopAgent VSIX E2E window."
Write-Host "vsix: $vsixPath"
Write-Host "user-data-dir: $userDataDir"
Write-Host "extensions-dir: $extensionsDir"
Write-Host "remote-debugging-port: $debugPort"
