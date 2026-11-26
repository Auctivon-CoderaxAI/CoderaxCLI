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

# install.ps1 keeps the batch file ASCII and stores the entrypoint
# base64-encoded, so the install path never appears verbatim in it.
function Test-UnderPrefix([string]$Candidate, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $trimmedRoot = $Root.TrimEnd('\', '/')
  $trimmedCandidate = $Candidate.TrimEnd('\', '/')
  if ($trimmedCandidate.Equals($trimmedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  # Compare on a separator boundary so a sibling "<root>-other" cannot match.
  foreach ($separator in @('\', '/')) {
    if ($trimmedCandidate.StartsWith($trimmedRoot + $separator, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Test-LauncherBelongsToPrefix([string]$LauncherPath, [string]$Root) {
  $content = Get-Content -Raw -LiteralPath $LauncherPath
  if ([string]::IsNullOrEmpty($content)) { return $false }
  if ($content.IndexOf($Root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  foreach ($match in [regex]::Matches($content, '[A-Za-z0-9+/]{24,}={0,2}')) {
    try {
      $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Value))
    } catch {
      continue
    }
    if (Test-UnderPrefix $decoded $Root) { return $true }
  }
  return $false
}

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
  if (Test-LauncherBelongsToPrefix $launcher $Prefix) {
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
