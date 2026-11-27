# Installing Coderax CLI

Coderax CLI is the owner-only command-line client for a cloud-hosted Coderax
deployment. It is a small, dependency-free Node.js program.

**Private distribution:** the release repository is private. Download release
assets with an authenticated GitHub client, never from an anonymous
`releases/download` URL. The examples below use `gh`, which reads the token from
its own credential store.

## Requirements

| Requirement | Detail |
| --- | --- |
| Node.js | 24.0.0 or newer (`node --version`) |
| Network | HTTPS access to your Coderax deployment |
| Disk | About 200 KB per installed version |
| Privileges | None. Everything installs under your user account. |
| Shell | bash, zsh, sh, PowerShell 5.1+, or cmd.exe |

The installer checks the Node version and stops if it is too old. It does not
install Node for you.

## What installation does not do

Installing this CLI does **not** install, start, or require Ollama, Docker,
containers, databases, background agents or services, Python, compilers, or
native build tools. Coderax inference and state live in the hosted deployment.

`package.json` has no `preinstall`, `install`, or `postinstall` script. The only
shipped modules that spawn a process are the credential helper (fixed OS
commands) and the explicit `--notify-command` feature; `npm run verify` enforces
that allowlist.

## Verify what you downloaded

Every release publishes a `SHA256SUMS` file next to the artifacts. Verify before
running anything.

Linux:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

Windows PowerShell:

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $hash, $file = $_ -split '  '
  if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $hash) { throw "checksum mismatch: $file" }
}
```

Release assets require authentication: <https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases>.

Use `--provenance` / `-Provenance` (or `CODERAX_REQUIRE_PROVENANCE=1`)
to verify the archive after the checksum check. Install Cosign on PATH
for releases with a `.sigstore.json` bundle. The installer downloads the
bundle alongside the archive and verifies the signature from the CoderaxCLI
release workflow. For `--from-file` / `-FromFile`, save the bundle next to
the archive with `.sigstore.json` appended to the archive filename.

If the bundle is absent (HTTP 404 for a download, or no local sidecar),
the installer requires the GitHub CLI (`gh`) and a valid legacy GitHub
attestation. Invalid bundles, other bundle download failures, and releases
without either verified form of evidence stop installation.

## Option A — standalone installer (Linux and macOS)

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:ae262277175a4f14ade6768f3a363a759959c5166e1f9da88ba5e479803c61f6 -->

```sh
(
  set -e
  version=0.3.0
  release_dir="$(mktemp -d "${TMPDIR:-/tmp}/coderax-release.XXXXXX")"
  release_dir="$(cd "$release_dir" && pwd -P)"
  gh release download "v$version" \
    --repo Auctivon-CoderaxAI/CoderaxCLI \
    --dir "$release_dir"

  cd "$release_dir"
  installer_checksum="$(grep '  install.sh$' "$release_dir/SHA256SUMS")"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$installer_checksum" | sha256sum -c -
  else
    printf '%s\n' "$installer_checksum" | shasum -a 256 -c -
  fi
  archive="coderax-cli-$version-standalone.tar.gz"
  checksum="$(awk -v archive="$archive" '$2 == archive { print $1 }' "$release_dir/SHA256SUMS")"
  sh "$release_dir/install.sh" --version "$version" --from-file "$release_dir/$archive" --checksum "$checksum"
)
```

The installer verifies the local archive against the release `SHA256SUMS`,
extracts it with a traversal-safe extractor to a staging directory, proves the
staged launcher reports the expected version,
and only then moves it to `~/.coderax/cli/$version` and atomically repoints
`~/.local/bin/coderax`.

<!-- /coderabbit-ai-generated:v1 -->

| Option | Default | Meaning |
| --- | --- | --- |
| `--version <x.y.z>` | `latest` | Release to install |
| `--prefix <dir>` | `~/.coderax/cli` | Install root; versions live below it |
| `--bin-dir <dir>` | `~/.local/bin` | Where the `coderax` launcher goes |
| `--from-file <path>` | — | Install a local tarball (air-gapped) |
| `--checksum <sha256>` | — | Required with `--from-file` |
| `--base-url <url>` | GitHub Releases | HTTPS release mirror |
| `--provenance` | off | Verify a Sigstore bundle or legacy GitHub attestation |
| `--force` | off | Atomically replace the same version, retaining a rollback copy |
| `--dry-run` | off | Print the plan and change nothing |
| `--skip-verify` | off | Skip checksum verification (not recommended) |

The installer never edits your shell profile and never accepts a token.

## Option B — standalone installer (Windows)

```powershell
$version = "0.3.0"
$releaseDir = Join-Path ([System.IO.Path]::GetTempPath()) ("coderax-release-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $releaseDir | Out-Null
gh release download "v$version" --repo Auctivon-CoderaxAI/CoderaxCLI --dir $releaseDir

$checksums = Join-Path $releaseDir 'SHA256SUMS'
$installer = Join-Path $releaseDir 'install.ps1'
$expected = (Select-String -Path $checksums -Pattern '  install\.ps1$').Line.Split(' ')[0]
if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw "checksum mismatch" }

$archive = Join-Path $releaseDir "coderax-cli-$version-standalone.zip"
$checksum = (Select-String -Path $checksums -Pattern "  coderax-cli-$version-standalone\.zip$").Line.Split(' ')[0]
powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Version $version -FromFile $archive -Checksum $checksum
```

Defaults: program in `%LOCALAPPDATA%\Coderax\cli\<version>`, launcher
`%LOCALAPPDATA%\Coderax\bin\coderax.cmd`. It does not change `PATH`.

Options mirror the POSIX installer: `-Version`, `-Prefix`, `-BinDir`,
`-FromFile`, `-Checksum`, `-BaseUrl`, `-Provenance`, `-Force`, `-DryRun`,
`-SkipVerify`.

## Option C — npm

The package is **not published to any public registry**: `package.json` contains
`"private": true`, and the release workflow has no npm publication job. Install
an authenticated release tarball directly; it contains no dependencies:

```sh
npm install --global ./coderax-cli-0.3.0.tgz
npx coderax --version
```

## Option D — from source

```sh
git clone https://github.com/Auctivon-CoderaxAI/CoderaxCLI.git
cd CoderaxCLI
npm ci --ignore-scripts
node src/cli.js --version
```

## Option E — air-gapped

Download the standalone archive and `SHA256SUMS` on a connected machine, transfer
them, verify the checksum, then:

```sh
sh install.sh --version 0.3.0 \
  --from-file ./coderax-cli-0.3.0-standalone.tar.gz \
  --checksum "<sha256 from SHA256SUMS>"
```

## First run — authenticate without leaking the token

A token is refused as a command-line argument: argv appears in shell history and
process listings.

```sh
coderax login                       # terminal prompt, echo disabled
printf '%s' "$CODERAX_TOKEN" | coderax login    # CI
coderax login --token-file ~/.coderax/token     # file must be 0600
```

`coderax login` verifies that the identity has the deployment owner role
(`ADMIN`) before storing anything. The token is then stored in the OS credential
store where one exists without an argv interface:

| Platform | Store |
| --- | --- |
| Windows | DPAPI (encrypted to the user account) |
| Linux | Secret Service via `secret-tool`; otherwise the `0600` config file |
| macOS | `0600` config file (the Keychain CLI cannot accept a secret without argv) |

Force the file store with `CODERAX_CREDENTIAL_STORE=file`.

```sh
coderax doctor          # environment, install, reachability, API and deployment version
coderax compat          # explicit two-axis compatibility verdict
coderax status
coderax chat "Summarize this repository"
```

Remote deployments must use HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1`.

## Confirm the installation

```sh
coderax --version            # coderax-cli 0.3.0
coderax version --json       # machine-readable install report
coderax help                 # command list
```

`coderax version --json` reports `cliVersion`, `node`, `platform`, `arch`,
`installMethod` (`standalone`, `npm-global`, `npm-local`, or `source`),
`installPath`, `configPath`, `supportedApiVersion`,
`supportedDeploymentRange`, and `compatibilityBasis`.

## PATH setup

POSIX:

```sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.profile or ~/.zshrc yourself
```

Windows, per-user `PATH`:

```powershell
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:LOCALAPPDATA\Coderax\bin",
  'User'
)
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Node.js is required but was not found` | Node missing from `PATH` | Install Node 24+ from <https://nodejs.org/> |
| `Node.js 24 or newer is required` | Older runtime | Upgrade Node |
| `checksum mismatch` | Truncated download, proxy, or tampering | Re-download; do not use `--skip-verify` |
| `checksum mismatch` after a tampered archive | Integrity check worked | Do not install that file |
| `archive failed safe extraction` | Absolute path, `..`, symlink, duplicate or overwrite in the archive | Treat the download as hostile; re-download from the release |
| `version X is already installed` | Re-running the same version | Use `--force` to replace it atomically |
| `--token is refused` | A token was passed in argv | Use `coderax login`, stdin, `--token-file`, or `CODERAX_TOKEN` |
| `coderax: command not found` | Launcher directory not on `PATH` | See PATH setup |
| `BASE_URL_INSECURE` | Remote URL is `http://` | Use `https://`; HTTP is loopback-only |
| `HTTP_401` / `HTTP_403` | Missing, expired, or revoked token | `coderax login` |
| `compat` says unsupported | API major or deployment version outside the contract | See [COMPATIBILITY.md](COMPATIBILITY.md) |
| PowerShell refuses to run the script | Execution policy | `-ExecutionPolicy Bypass` for that process only |

## Next steps

- [UPGRADE.md](UPGRADE.md) — atomic upgrades
- [ROLLBACK.md](ROLLBACK.md) — returning to a previous version
- [COMPATIBILITY.md](COMPATIBILITY.md) — runtime and deployment compatibility
