function ConvertTo-WindowsCommandLineArgument {
  param(
    [Parameter(Mandatory)]
    [AllowEmptyString()]
    [string]$Argument
  )

  if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
    return $Argument
  }

  $quoted = '"'
  $backslashCount = 0

  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') {
      $backslashCount++
      continue
    }

    if ($character -eq '"') {
      $quoted += ('\' * (($backslashCount * 2) + 1))
      $quoted += '"'
      $backslashCount = 0
      continue
    }

    if ($backslashCount -gt 0) {
      $quoted += ('\' * $backslashCount)
      $backslashCount = 0
    }
    $quoted += $character
  }

  if ($backslashCount -gt 0) {
    $quoted += ('\' * ($backslashCount * 2))
  }
  $quoted += '"'

  return $quoted
}

function Test-VsixE2eProcessCommandLine {
  param(
    [Parameter(Mandatory)]
    [AllowEmptyString()]
    [string]$CommandLine,

    [Parameter(Mandatory)]
    [string]$UserDataDir
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }

  $argument = "--user-data-dir=$UserDataDir"
  $escapedArgument = [Regex]::Escape($argument)
  $argumentPattern = '"' + $escapedArgument + '"'
  if ($argument -notmatch '\s') {
    $argumentPattern = '(?:' + $argumentPattern + '|' + $escapedArgument + ')'
  }
  $pattern = '(?:^|\s)' + $argumentPattern + '(?=$|\s)'

  return [Regex]::IsMatch(
    $CommandLine,
    $pattern,
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
}

function Stop-VsixE2eProcess {
  param(
    [Parameter(Mandatory)]
    [int]$TargetProcessId,

    [int]$TimeoutSeconds = 10
  )

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

Export-ModuleMember -Function @(
  "ConvertTo-WindowsCommandLineArgument",
  "Test-VsixE2eProcessCommandLine",
  "Stop-VsixE2eProcess"
)
