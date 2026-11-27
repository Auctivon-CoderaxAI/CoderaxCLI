# Remove a standalone Coderax CLI installation on Windows.
# User data is only removed with -Purge, because credentials may be worth keeping.
[CmdletBinding()]
param(
  [string]$Prefix = $(if ($env:CODERAX_PREFIX) { $env:CODERAX_PREFIX } else { Join-Path $env:LOCALAPPDATA "Coderax\cli" }),
  [string]$BinDir = $(if ($env:CODERAX_BIN_DIR) { $env:CODERAX_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Coderax\bin" }),
  [string]$Version,
  [switch]$Purge,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error "coderax uninstall: $Message" -ErrorAction Continue
  exit $Code
}

if ([string]::IsNullOrWhiteSpace($Prefix) -or $Prefix -eq "/" -or $Prefix -eq $env:USERPROFILE) {
  Fail "refusing to remove '$Prefix'" 2
}

$launcher = Join-Path $BinDir "coderax.cmd"
$config = if ($env:CODERAX_CONFIG) { $env:CODERAX_CONFIG } else { Join-Path $env:USERPROFILE ".coderax\config.json" }

$targets = @()
if ($Version) {
  $candidate = Join-Path $Prefix $Version
  if (Test-Path -LiteralPath $candidate) { $targets += $candidate }
} elseif (Test-Path -LiteralPath $Prefix) {
  $targets = @(Get-ChildItem -LiteralPath $Prefix -Directory | ForEach-Object { $_.FullName })
}

Write-Host "coderax uninstall plan"
if ($targets.Count -gt 0) { Write-Host "  program   $($targets -join ', ')" } else { Write-Host "  program   (none found under $Prefix)" }
if (Test-Path -LiteralPath $launcher) { Write-Host "  launcher  $launcher" }
if ($Purge) { Write-Host "  user data $config" }

if (-not $Yes) {
  Write-Host "Re-run with -Yes to remove the items above."
  exit 0
}

foreach ($target in $targets) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

# Only remove the launcher when it came from this prefix.
if (Test-Path -LiteralPath $launcher) {
  $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $launcher
  $target = $null
  # Read the launcher's target as data; never execute the launcher to find it.
  if ($content -match '(?m)^node -e "const p = Buffer\.from\(''(?<path>[A-Za-z0-9+/=]+)'', ''base64''\)\.toString\(''utf8''\); ') {
    try {
      $target = [System.Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String($Matches['path']))
    } catch {
      # An invalid path encoding does not establish ownership.
    }
  } elseif ($content -match '(?m)^call "(?<path>[^"\r\n]+)" %\*\r?$') {
    # Older installers called the versioned batch file directly.
    $target = $Matches['path']
  }

  $prefixPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Prefix)
  $escapedPrefix = [regex]::Escape($prefixPath.TrimEnd([char[]]'\/'))
  # Require a versioned entry point inside this prefix, including the path separator.
  if ($target -match "\A$escapedPrefix[\\/]\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?[\\/](?:src[\\/]cli\.js|bin[\\/]coderax\.cmd)\z") {
    Remove-Item -LiteralPath $launcher -Force
  } else {
    Write-Warning "leaving $launcher (it does not reference $Prefix)"
  }
}

if ($Purge) {
  Remove-Item -LiteralPath $config -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath (Split-Path -Parent $config) -Filter "config.json.*.tmp" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

if ((Test-Path -LiteralPath $Prefix) -and -not (Get-ChildItem -LiteralPath $Prefix -Force)) {
  Remove-Item -LiteralPath $Prefix -Force
}

Write-Host "coderax-cli removed"
