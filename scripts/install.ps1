# Coderax CLI installer for Windows.
#
# Downloads one release archive, verifies its SHA-256 checksum, extracts it
# under a versioned directory, and creates a launcher. It never installs
# Node.js, Ollama, containers, databases, or background services, and never
# modifies PATH.
[CmdletBinding()]
param(
  [string]$Version = $env:CODERAX_VERSION,
  [string]$Prefix = $(if ($env:CODERAX_PREFIX) { $env:CODERAX_PREFIX } else { Join-Path $env:LOCALAPPDATA "Coderax\cli" }),
  [string]$BinDir = $(if ($env:CODERAX_BIN_DIR) { $env:CODERAX_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Coderax\bin" }),
  [string]$FromFile,
  [string]$Checksum,
  [string]$BaseUrl = "https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases",
  [string]$CompletionDir = $(if ($env:CODERAX_COMPLETION_DIR) { $env:CODERAX_COMPLETION_DIR } else { Join-Path $env:LOCALAPPDATA "Coderax\completions" }),
  [switch]$DryRun,
  [switch]$SkipVerify,
  [switch]$Force,
  [switch]$NoCompletion,
  [switch]$Rollback
)

$ErrorActionPreference = "Stop"
$repo = "Auctivon-CoderaxAI/CoderaxCLI"

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error "coderax install: $Message" -ErrorAction Continue
  exit $Code
}

if (-not $Version) { $Version = "latest" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js is required but was not found on PATH. Install Node.js 24 or newer from https://nodejs.org/ and run this installer again. This installer deliberately does not install runtimes, containers, databases, Ollama, or background services." 2
}

$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 24) {
  Fail "Node.js 24 or newer is required (found $nodeVersion)." 2
}

if ([string]::IsNullOrWhiteSpace($Prefix) -or $Prefix -eq "/" -or $Prefix -eq $env:USERPROFILE) {
  Fail "refusing to use '$Prefix' as the install prefix" 2
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Save-File([string]$Url, [string]$Destination) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

if ($FromFile -and $Version -eq "latest") {
  Fail "--FromFile requires -Version <x.y.z>." 2
}

if ($Version -eq "latest") {
  $tmpLatest = Join-Path ([System.IO.Path]::GetTempPath()) ("coderax-latest-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    Save-File "https://api.github.com/repos/$repo/releases/latest" $tmpLatest
    $release = Get-Content -Raw -LiteralPath $tmpLatest | ConvertFrom-Json
    $Version = ([string]$release.tag_name) -replace '^v', ''
  } finally {
    Remove-Item -LiteralPath $tmpLatest -Force -ErrorAction SilentlyContinue
  }
}

if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$') {
  Fail "invalid version: $Version" 2
}

$asset = "coderax-cli-$Version-standalone.zip"
$destination = Join-Path $Prefix $Version
$launcher = Join-Path $BinDir "coderax.cmd"

function Set-Launcher([string]$Target) {
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $shim = "@echo off`r`ncall `"$Target\bin\coderax.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
  Set-Content -LiteralPath $launcher -Value $shim -Encoding ascii -NoNewline
}

function Set-Completion([string]$Target) {
  if ($NoCompletion) { return $null }
  New-Item -ItemType Directory -Path $CompletionDir -Force | Out-Null
  $path = Join-Path $CompletionDir "coderax.ps1"
  & node (Join-Path $Target "src\cli.js") completion powershell |
    Set-Content -LiteralPath $path -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { Fail "could not generate the PowerShell completion script" }
  return $path
}

# Rollback only repoints the launcher at a version that is already on disk.
if ($Rollback) {
  if (-not $Version -or $Version -eq "latest") { Fail "-Rollback requires -Version <x.y.z>." 2 }
  if (-not (Test-Path -LiteralPath (Join-Path $destination "src\cli.js"))) {
    Fail "version $Version is not installed at $destination" 1
  }
  if ($DryRun) {
    Write-Host "coderax rollback plan (dry run, nothing was changed)"
    Write-Host "  version    $Version"
    Write-Host "  launcher   $launcher -> $destination\bin\coderax.cmd"
    exit 0
  }
  Set-Launcher $destination
  $reported = (& node (Join-Path $destination "src\cli.js") --version).Trim()
  if ($reported -ne "coderax-cli $Version") {
    Fail "launcher did not report $Version after rollback (got '$reported')" 1
  }
  $completionPath = Set-Completion $destination
  Write-Host "coderax-cli $Version restored"
  Write-Host "  program   $destination"
  Write-Host "  launcher  $launcher"
  if ($completionPath) { Write-Host "  completion $completionPath" }
  exit 0
}

if ($DryRun) {
  Write-Host "coderax install plan (dry run, nothing was changed)"
  Write-Host "  version    $Version"
  Write-Host "  package    $asset"
  Write-Host "  install    $destination"
  Write-Host "  launcher   $launcher"
  Write-Host "  node       $nodeVersion"
  Write-Host "  verify     $(if ($SkipVerify) { 'disabled' } else { 'sha256' })"
  Write-Host "  completion $(if ($NoCompletion) { 'disabled' } else { "$CompletionDir\coderax.ps1" })"
  exit 0
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("coderax-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
  if ($FromFile) {
    if (-not (Test-Path -LiteralPath $FromFile)) { Fail "archive not found: $FromFile" 2 }
    $archive = $FromFile
    if ($Checksum -and -not $SkipVerify) {
      if ((Get-Sha256 $archive) -ne $Checksum.ToLowerInvariant()) { Fail "checksum mismatch for $archive" 3 }
    } elseif (-not $SkipVerify) {
      Fail "-FromFile requires -Checksum, or -SkipVerify to install unverified." 2
    }
  } else {
    $releaseBase = if ($Version -eq "latest") { "$BaseUrl/download/latest" } else { "$BaseUrl/download/v$Version" }
    $archive = Join-Path $temp $asset
    Save-File "$releaseBase/$asset" $archive
    if (-not $SkipVerify) {
      $sumsPath = Join-Path $temp "SHA256SUMS"
      Save-File "$releaseBase/SHA256SUMS" $sumsPath
      $line = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match [regex]::Escape("  $asset") } | Select-Object -First 1
      if (-not $line) { Fail "SHA256SUMS does not list $asset" 3 }
      $expected = ($line -split '\s+')[0].ToLowerInvariant()
      if ((Get-Sha256 $archive) -ne $expected) { Fail "checksum mismatch for $asset" 3 }
    } else {
      Write-Warning "checksum verification disabled"
    }
  }

  Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force
  $extracted = Join-Path $temp "coderax-cli-$Version"
  if (-not (Test-Path -LiteralPath (Join-Path $extracted "src\cli.js"))) {
    Fail "unexpected archive layout: src\cli.js is missing" 3
  }

  if (Test-Path -LiteralPath $destination) {
    if ($Force) {
      Remove-Item -LiteralPath $destination -Recurse -Force
    } else {
      Fail "version $Version is already installed at $destination (use -Force to replace it)"
    }
  }

  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Move-Item -LiteralPath $extracted -Destination $destination

  # A shim rather than a copied launcher: the shipped launcher resolves paths
  # relative to its own location, so copying it would break.
  Set-Launcher $destination

  $installed = (& node (Join-Path $destination "src\cli.js") --version).Trim()
  if ($installed -ne "coderax-cli $Version") {
    Fail "installed launcher did not report the expected version (got '$installed')"
  }

  # Completion comes from the installed launcher, so it matches the active
  # version. No PowerShell profile is edited; the path is printed instead.
  $completionPath = Set-Completion $destination

  Write-Host "coderax-cli $Version installed"
  Write-Host "  program   $destination"
  Write-Host "  launcher  $launcher"
  if ($completionPath) {
    Write-Host "  completion $completionPath"
    Write-Host "             load it: . `"$completionPath`""
  } elseif ($NoCompletion) {
    Write-Host "  completion skipped (-NoCompletion)"
  }
  if (($env:PATH -split ';') -notcontains $BinDir) {
    Write-Host "  PATH      add it: [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$BinDir', 'User')"
  }
  Write-Host ""
  Write-Host "Next: coderax config set --base-url https://your-deployment --token <token>"
  Write-Host "      coderax doctor; coderax compat"
  Write-Host "No other software was installed: no Node.js runtime, Ollama, containers,"
  Write-Host "databases, or background services. Coderax runs in the cloud deployment."
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
