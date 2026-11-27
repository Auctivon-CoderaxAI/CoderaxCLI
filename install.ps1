# Install a published Coderax CLI release without npm or elevation.
#
#   $env:CODERAX_VERSION = "1.0.0"; .\install.ps1
#
# The ZIP and SHA256SUMS are fetched over HTTPS from the GitHub release.
param(
  [string]$Version = $(if ($env:CODERAX_VERSION) { $env:CODERAX_VERSION } else { "1.0.0" }),
  [string]$InstallRoot = $(if ($env:CODERAX_HOME) { $env:CODERAX_HOME } else { Join-Path $env:LOCALAPPDATA "Coderax" })
)

$ErrorActionPreference = "Stop"
if ($Version -notmatch '^[0-9A-Za-z._-]+$') { throw "Invalid version: $Version" }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 24 or newer is required" }
$major = & node -p "process.versions.node.split('.')[0]"
if ([int]$major -lt 24) { throw "Node.js 24 or newer is required (found $(& node --version))" }

$architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}
$base = if ($env:CODERAX_RELEASE_BASE) {
  $env:CODERAX_RELEASE_BASE
} else {
  "https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases/download/v$Version"
}
$archive = "coderax-cli-$Version-windows-$architecture.zip"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("coderax-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null

try {
  Write-Host "Downloading $archive"
  $zip = Join-Path $temp $archive
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $zip
  $sumsPath = Join-Path $temp "SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sumsPath

  $line = Get-Content $sumsPath | Where-Object { $_ -match "\s$([regex]::Escape($archive))$" } | Select-Object -First 1
  if (-not $line) { throw "$archive is not listed in SHA256SUMS" }
  $expected = ($line -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "SHA256 mismatch for $archive" }

  $unpack = Join-Path $temp "unpack"
  Expand-Archive -Path $zip -DestinationPath $unpack -Force
  $dest = Join-Path $InstallRoot "cli\$Version"
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item -Path (Join-Path $unpack "package\*") -Destination $dest -Recurse -Force

  $bin = Join-Path $InstallRoot "bin"
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $launcher = Join-Path $bin "coderax.cmd"
  $contents = "@echo off`r`nnode `"%~dp0..\cli\$Version\src\cli.js`" %*`r`n"
  Set-Content -Path $launcher -Value $contents -Encoding ASCII
  & $launcher --version
  if ($LASTEXITCODE -ne 0) { throw "Installed launcher failed its version check (exit $LASTEXITCODE)" }
  Write-Host ""
  Write-Host "Installed Coderax CLI $Version in $dest"
  Write-Host "Add this directory to PATH if needed:"
  Write-Host "  $bin"
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
