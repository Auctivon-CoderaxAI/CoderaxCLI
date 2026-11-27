# Installing Coderax CLI

Coderax CLI is the owner-only command-line client for a cloud-hosted Coderax
deployment. It is a small, dependency-free Node.js program.

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

Release downloads are public: <https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases>.

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

```sh
version=0.3.0
base="https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases/download/v$version"

curl -fsSLO "$base/install.sh"
curl -fsSLO "$base/SHA256SUMS"
grep '  install.sh$' SHA256SUMS | sha256sum -c -

sh install.sh --version "$version"
```

The installer downloads `coderax-cli-$version-standalone.tar.gz`, verifies it
against the release `SHA256SUMS`, extracts it with a traversal-safe extractor to
a staging directory, proves the staged launcher reports the expected version,
and only then moves it to `~/.coderax/cli/$version` and atomically repoints
`~/.local/bin/coderax`.

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
$base = "https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases/download/v$version"

Invoke-WebRequest "$base/install.ps1" -OutFile install.ps1
Invoke-WebRequest "$base/SHA256SUMS" -OutFile SHA256SUMS
$expected = (Select-String -Path SHA256SUMS -Pattern '  install\.ps1$').Line.Split(' ')[0]
if ((Get-FileHash install.ps1 -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw "checksum mismatch" }

powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version $version
```

Defaults: program in `%LOCALAPPDATA%\Coderax\cli\<version>`, launcher
`%LOCALAPPDATA%\Coderax\bin\coderax.cmd`. It does not change `PATH`.

Options mirror the POSIX installer: `-Version`, `-Prefix`, `-BinDir`,
`-FromFile`, `-Checksum`, `-BaseUrl`, `-Provenance`, `-Force`, `-DryRun`,
`-SkipVerify`.

## Option C — npm

The package is **not published to the registry**: `package.json` contains
`"private": true` so publication is an explicit owner decision. Install a
release tarball directly; it contains no dependencies:

```sh
npm install --global ./coderax-cli-0.3.0.tgz
npx coderax --version
```

## Shell completion

`coderax completion <bash|zsh|fish|powershell>` prints a completion script. The
standalone installers write the file for every shell they find and never edit a
shell profile.

| Shell | Installed path | To enable |
| --- | --- | --- |
| bash | `~/.local/share/bash-completion/completions/coderax` | Open a new shell |
| zsh | `~/.local/share/zsh/site-functions/_coderax` | Add that directory to `fpath` before `compinit` |
| fish | `~/.config/fish/completions/coderax.fish` | Automatic |
| PowerShell | `%LOCALAPPDATA%\Coderax\completions\coderax.ps1` | Dot-source it from `$PROFILE` |

POSIX paths honour `XDG_DATA_HOME` and `XDG_CONFIG_HOME`; PowerShell honours
`CODERAX_COMPLETION_DIR`. To install manually:

```sh
coderax completion bash > "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/coderax"
coderax completion zsh > "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_coderax"
coderax completion fish > "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/coderax.fish"
```

For zsh, add this to `~/.zshrc` before `compinit`:

```zsh
fpath=("${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions" $fpath)
```

PowerShell, add this line to `$PROFILE`:

```powershell
. "$env:LOCALAPPDATA\Coderax\completions\coderax.ps1"
```

Skip automatic installation with `--no-completion` (POSIX) or `-NoCompletion`
(Windows). Uninstall removes only files carrying the `coderax-cli shell
completion` marker, so a hand-written completion file with the same name is kept.

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

Login verifies owner access before writing to the OS credential store.

| Platform | Store |
| --- | --- |
| Windows | DPAPI (encrypted to the user account) |
| Linux | Secret Service via `secret-tool` |
| macOS | Keychain via `security -i` |

Use `CODERAX_TOKEN` for ephemeral automation when a store is unavailable.

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
