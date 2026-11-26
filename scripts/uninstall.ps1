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

# Only remove the launcher when it came from this prefix. The Windows shim
# keeps its entrypoint base64-encoded so paths with spaces and Unicode survive
# cmd.exe, so inspect both the literal text and the embedded payload.
if (Test-Path -LiteralPath $launcher) {
  $content = Get-Content -Raw -LiteralPath $launcher
  $marker = $Prefix.TrimEnd([char]'\') + '\'
  $owned = [bool]($content -and $content.Contains($marker))
  if (-not $owned -and $content) {
    $pattern = 'Buffer\.from\(''([A-Za-z0-9+/=]+)'',\s*''base64''\)'
    foreach ($encoded in [regex]::Matches($content, $pattern)) {
      try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded.Groups[1].Value))
      } catch {
        continue
      }
      if ($decoded.Contains($marker)) { $owned = $true; break }
    }
  }
  if ($owned) {
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
