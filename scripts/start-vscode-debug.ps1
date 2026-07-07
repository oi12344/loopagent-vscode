param(
  [switch]$KeepExisting
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$extensionPath = $projectRoot.Path
$userDataDir = Join-Path $extensionPath ".local-vscode-user-data"
$extensionsDir = Join-Path $extensionPath ".local-vscode-extensions"
$debugPort = 9333

function Find-CodeCli {
  $command = Get-Command code -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
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

  throw "未找到 VS Code CLI。请确认 code 命令已加入 PATH，或已安装 Visual Studio Code。"
}

function Stop-ExistingLoopAgentDevHost {
  $escapedPath = [Regex]::Escape($extensionPath)
  $processes = Get-CimInstance Win32_Process -Filter "name = 'Code.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match "--extensionDevelopmentPath" -and
      $_.CommandLine -match $escapedPath
    }

  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if (-not $KeepExisting) {
  Stop-ExistingLoopAgentDevHost
}

New-Item -ItemType Directory -Force -Path $userDataDir, $extensionsDir | Out-Null

$codeCli = Find-CodeCli
$args = @(
  "--new-window",
  "--extensionDevelopmentPath=$extensionPath",
  "--user-data-dir=$userDataDir",
  "--extensions-dir=$extensionsDir",
  "--remote-debugging-port=$debugPort",
  "--disable-workspace-trust"
)

Start-Process -FilePath $codeCli -ArgumentList $args -WindowStyle Hidden

Write-Host "已启动单一 LoopAgent VS Code 调试窗口。"
Write-Host "extensionDevelopmentPath: $extensionPath"
Write-Host "user-data-dir: $userDataDir"
Write-Host "extensions-dir: $extensionsDir"
Write-Host "remote-debugging-port: $debugPort"
