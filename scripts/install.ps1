# Coderax CLI installer for Windows.
#
# Downloads one release archive, verifies its SHA-256 checksum (and, with
# -Provenance, the release's build provenance), extracts it with a traversal-
# and symlink-safe extractor, stages it, and swaps the launcher into place with
# a same-volume move. A failed swap restores the previous install.
#
# It never installs Node.js, Ollama, containers, databases, or background
# services, and never modifies PATH. It never accepts, stores, or prints a
# token: run `coderax login` afterwards.
[CmdletBinding()]
param(
  [string]$Version = $env:CODERAX_VERSION,
  [string]$Prefix = $(if ($env:CODERAX_PREFIX) { $env:CODERAX_PREFIX } else { Join-Path $env:LOCALAPPDATA "Coderax\cli" }),
  [string]$BinDir = $(if ($env:CODERAX_BIN_DIR) { $env:CODERAX_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Coderax\bin" }),
  [string]$FromFile,
  [string]$Checksum,
  [string]$BaseUrl = "https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases",
  [switch]$Provenance,
  [switch]$DryRun,
  [switch]$SkipVerify,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repo = "Auctivon-CoderaxAI/CoderaxCLI"

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error "coderax install: $Message" -ErrorAction Continue
  exit $Code
}

if (-not $Version) { $Version = "latest" }
if ($env:CODERAX_REQUIRE_PROVENANCE) { $Provenance = $true }

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

$releaseUri = $null
if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$releaseUri) -or
    ($releaseUri.Scheme -ne 'https' -and
      ($releaseUri.Scheme -ne 'http' -or $releaseUri.Host -notin @('localhost', '127.0.0.1')))) {
  Fail "releases URL must use HTTPS or HTTP on localhost or 127.0.0.1." 2
}

# Get-FileHash is a Utility cmdlet and is not available in every PowerShell
# session (module autoloading can be disabled by policy). Hash through .NET so
# verification does not depend on cmdlet discovery, and fall back to certutil.
function Get-Sha256([string]$Path) {
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $bytes = $sha.ComputeHash($stream)
    } finally {
      $stream.Dispose()
      $sha.Dispose()
    }
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  } catch {
    $out = & certutil.exe -hashfile $Path SHA256 2>$null
    if ($LASTEXITCODE -ne 0) { throw "could not hash ${Path}: $($_.Exception.Message)" }
    $hash = $out | Where-Object { $_ -match '^[0-9a-fA-F]{64}$' } | Select-Object -First 1
    if (-not $hash) { throw "certutil produced no SHA-256 digest for $Path" }
    return $hash.ToLowerInvariant()
  }
}

function Save-File([string]$Url, [string]$Destination) {
  $client = New-Object System.Net.WebClient
  try {
    $client.Headers.Add("User-Agent", "coderax-installer")
    $client.DownloadFile($Url, $Destination)
  } finally {
    $client.Dispose()
  }
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
$Prefix = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Prefix)
$BinDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BinDir)
$destination = Join-Path $Prefix $Version
$launcher = Join-Path $BinDir "coderax.cmd"

if ($DryRun) {
  Write-Host "coderax install plan (dry run, nothing was changed)"
  Write-Host "  version    $Version"
  Write-Host "  package    $asset"
  Write-Host "  install    $destination"
  Write-Host "  launcher   $launcher"
  Write-Host "  node       $nodeVersion"
  Write-Host "  verify     $(if ($SkipVerify) { 'disabled' } else { 'sha256' })$(if ($Provenance) { ' + provenance' } else { '' })"
  exit 0
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("coderax-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$backup = $null
$staging = $null
$tmpLauncher = $null

try {
  if ($FromFile) {
    if (-not (Test-Path -LiteralPath $FromFile)) { Fail "archive not found: $FromFile" 2 }
    $archive = $FromFile
    if (-not $SkipVerify) {
      if (-not $Checksum) { Fail "-Checksum is required for -FromFile (or pass -SkipVerify explicitly)." 2 }
      if ((Get-Sha256 $archive) -ne $Checksum.ToLowerInvariant()) { Fail "checksum mismatch for $archive" 3 }
    } else {
      Write-Warning "checksum verification disabled"
    }
  } else {
    $releaseBase = "$($releaseUri.AbsoluteUri.TrimEnd('/'))/download/v$Version"
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

  if ($Provenance) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { Fail "-Provenance requires the GitHub CLI (gh)." 3 }
    & gh attestation verify $archive --repo $repo | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "provenance verification failed for $archive" 3 }
  }

  # Extractors are injected at release-build time; see scripts/install.sh.
  $extractDir = Join-Path $temp "extract"
  New-Item -ItemType Directory -Path (Join-Path $extractDir "lib") -Force | Out-Null
  $archiveMjs = Join-Path $extractDir "lib\archive.mjs"
  $extractMjs = Join-Path $extractDir "lib\safe-extract.mjs"
  [IO.File]::WriteAllBytes($archiveMjs, [Convert]::FromBase64String(@'
@CODERAX_ARCHIVE_B64@
'@))
  [IO.File]::WriteAllBytes($extractMjs, [Convert]::FromBase64String(@'
@CODERAX_EXTRACT_B64@
'@))

  # The final directory move must stay on the same volume as the prefix.
  $staging = Join-Path $Prefix (".stage-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  & node $extractMjs $archive $staging | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "archive failed safe extraction" 3 }

  $extracted = Join-Path $staging "coderax-cli-$Version"
  if (-not (Test-Path -LiteralPath (Join-Path $extracted "src\cli.js"))) {
    Fail "unexpected archive layout: src\cli.js is missing" 3
  }
  if (-not (Test-Path -LiteralPath (Join-Path $extracted "bin\coderax.cmd"))) {
    Fail "unexpected archive layout: bin\coderax.cmd is missing" 3
  }

  $staged = (& node (Join-Path $extracted "src\cli.js") --version).Trim()
  if ($staged -ne "coderax-cli $Version") {
    Fail "staged build did not report the expected version (got '$staged')" 3
  }

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

  if (Test-Path -LiteralPath $destination) {
    if (-not $Force) { Fail "version $Version is already installed at $destination (use -Force to replace it)" 1 }
    $backup = Join-Path $Prefix (".rollback-$Version-" + [guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $destination -Destination $backup
  }

  try {
    Move-Item -LiteralPath $extracted -Destination $destination
  } catch {
    if ($backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $destination }
    Fail "could not move the staged install into place" 1
  }

  try {
    # Keep the batch file ASCII regardless of the console code page. Restore
    # Node's script argv layout before importing the CLI at its exact path.
    $entrypoint = Join-Path $destination "src\cli.js"
    $encodedPath = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($entrypoint))
    $shim = "@echo off`r`n" +
      "setlocal DisableDelayedExpansion`r`n" +
      "node -e `"const p = Buffer.from('$encodedPath', 'base64').toString('utf8'); process.argv.splice(1, 0, p); import(require('node:url').pathToFileURL(p).href)`" -- %*`r`n" +
      "exit /b %ERRORLEVEL%`r`n"
    $tmpLauncher = Join-Path $BinDir (".coderax-" + [guid]::NewGuid().ToString("N") + ".cmd")
    [System.IO.File]::WriteAllText($tmpLauncher, $shim, [System.Text.Encoding]::ASCII)
    $installed = (& $tmpLauncher --version) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $installed.Trim() -ne "coderax-cli $Version") {
      throw "launcher version check failed (got '$installed')"
    }
    Move-Item -LiteralPath $tmpLauncher -Destination $launcher -Force
  } catch {
    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    if ($backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $destination }
    Fail "could not install the launcher: $($_.Exception.Message)" 1
  }

  if ($backup) { Write-Host "coderax install: previous $Version kept for rollback at $backup" }

  Write-Host "coderax-cli $Version installed"
  Write-Host "  program   $destination"
  Write-Host "  launcher  $launcher"
  if (($env:PATH -split ';') -notcontains $BinDir) {
    Write-Host "  PATH      add it: [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$BinDir', 'User')"
  }
  Write-Host ""
  Write-Host "Next: coderax login            (prompts with echo disabled; no token in argv)"
  Write-Host "      coderax doctor; coderax compat"
  Write-Host "No other software was installed: no Node.js runtime, Ollama, containers,"
  Write-Host "databases, or background services. Coderax runs in the cloud deployment."
} finally {
  if ($tmpLauncher) { Remove-Item -LiteralPath $tmpLauncher -Force -ErrorAction SilentlyContinue }
  if ($staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
