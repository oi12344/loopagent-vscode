param(
  [string]$Tag = "v6.1.1",
  [string]$Destination = "resources/superpowers"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($Tag -ne "v6.1.1") {
  throw "Only the pinned Superpowers tag v6.1.1 is supported. Received: $Tag"
}

$version = $Tag.Substring(1)
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$expectedDestinationPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "resources\\superpowers"))
$destinationPath = if ([System.IO.Path]::IsPathRooted($Destination)) {
  [System.IO.Path]::GetFullPath($Destination)
} else {
  [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Destination))
}
if (-not [string]::Equals($destinationPath, $expectedDestinationPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must be resources/superpowers: $Destination"
}
$destinationParent = Split-Path -Parent $destinationPath
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("loopagent-superpowers-" + [guid]::NewGuid())

try {
  $archivePath = Join-Path $temporaryRoot "superpowers.zip"
  $extractPath = Join-Path $temporaryRoot "extract"
  $stagedPath = Join-Path $temporaryRoot "superpowers"
  New-Item -ItemType Directory -Path $extractPath, $stagedPath -Force | Out-Null

  Invoke-WebRequest -Uri "https://github.com/obra/superpowers/archive/refs/tags/$Tag.zip" -OutFile $archivePath
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath

  $archiveRoot = Join-Path $extractPath "superpowers-$version"
  $licensePath = Join-Path $archiveRoot "LICENSE"
  $skillsPath = Join-Path $archiveRoot "skills"
  if (-not (Test-Path -LiteralPath $archiveRoot -PathType Container)) {
    throw "Unexpected archive root: expected superpowers-$version"
  }
  if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
    throw "Official LICENSE is missing from $Tag"
  }
  if (-not (Test-Path -LiteralPath $skillsPath -PathType Container)) {
    throw "Official skills directory is missing from $Tag"
  }

  Copy-Item -LiteralPath $licensePath -Destination (Join-Path $stagedPath "LICENSE")
  Copy-Item -LiteralPath $skillsPath -Destination (Join-Path $stagedPath "skills") -Recurse

  $skills = foreach ($skillFile in Get-ChildItem -LiteralPath (Join-Path $stagedPath "skills") -Filter "SKILL.md" -Recurse | Sort-Object FullName) {
    $content = Get-Content -LiteralPath $skillFile.FullName -Raw
    if ($content -notmatch "(?ms)^---\s*\r?\n(.*?)\r?\n---") {
      throw "Missing frontmatter: $($skillFile.FullName)"
    }
    $frontmatter = $Matches[1]
    if ($frontmatter -notmatch "(?m)^name:\s*(.+)$") {
      throw "Missing skill name: $($skillFile.FullName)"
    }
    $name = $Matches[1].Trim().Trim('"').Trim("'")
    if ($frontmatter -notmatch "(?m)^description:\s*(.+)$") {
      throw "Missing skill description: $($skillFile.FullName)"
    }
    $description = $Matches[1].Trim().Trim('"').Trim("'")
    if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($description)) {
      throw "Invalid skill frontmatter: $($skillFile.FullName)"
    }

    [pscustomobject]@{
      name = $name
      description = $description
      path = "skills/$($skillFile.Directory.Name)/SKILL.md"
    }
  }

  if (@($skills).Count -ne 14) {
    throw "Expected 14 official skills, found $(@($skills).Count)"
  }

  $manifest = [pscustomobject]@{
    version = $version
    skills = @($skills)
  } | ConvertTo-Json -Depth 3
  [System.IO.File]::WriteAllText(
    (Join-Path $stagedPath "manifest.json"),
    $manifest,
    [System.Text.UTF8Encoding]::new($false)
  )

  New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  if (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Recurse -Force
  }
  Copy-Item -LiteralPath $stagedPath -Destination $destinationPath -Recurse
  Write-Output "Vendored Superpowers $version to $destinationPath"
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
