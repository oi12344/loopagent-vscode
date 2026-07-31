# Start VSCode with project path
param(
  [Parameter(Mandatory=$true)]
  [string]$ProjectPath
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

  throw "VS Code CLI not found"
}

function Stop-ExistingLoopAgentDevHost {
  $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
  $listeners = & $netstat -ano -p TCP
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot check debug port $debugPort"
  }

  $processIds = $listeners |
    Where-Object { $_ -match "^\s*TCP\s+\S+:$debugPort\s+\S+\s+LISTENING\s+(\d+)\s*$" } |
    ForEach-Object { [int]$Matches[1] } |
    Sort-Object -Unique

  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -notin @("Code", "code")) {
      throw "Port $debugPort is occupied by non-VSCode process"
    }
    Stop-Process -Id $processId -Force -ErrorAction Stop
  }

  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    $remaining = & $netstat -ano -p TCP | Where-Object {
      $_ -match "^\s*TCP\s+\S+:$debugPort\s+\S+\s+LISTENING\s+\d+\s*$"
    }
    if (-not $remaining) {
      return
    }
    Start-Sleep -Milliseconds 100
  }

  throw "Old debug window still occupies port $debugPort"
}

if (-not (Test-Path -LiteralPath $ProjectPath)) {
  throw "Project path does not exist: $ProjectPath"
}

Stop-ExistingLoopAgentDevHost

New-Item -ItemType Directory -Force -Path $userDataDir, $extensionsDir | Out-Null

$codeCli = Find-CodeCli
$args = @(
  "--new-window",
  "--extensionDevelopmentPath=$extensionPath",
  "--user-data-dir=$userDataDir",
  "--extensions-dir=$extensionsDir",
  "--remote-debugging-port=$debugPort",
  "--disable-workspace-trust",
  $ProjectPath
)

Start-Process -FilePath $codeCli -ArgumentList $args -WindowStyle Hidden

Write-Host "VSCode started with project: $ProjectPath"
Write-Host "remote-debugging-port: $debugPort"
