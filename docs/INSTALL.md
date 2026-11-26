# Installing Coderax CLI

Coderax CLI is the command-line **access and control interface** for a
cloud-hosted Coderax deployment. It is a small, dependency-free Node.js program.

## Requirements

| Requirement | Detail |
| --- | --- |
| Node.js | 24.0.0 or newer (`node --version`) |
| Network | HTTPS access to your Coderax deployment |
| Disk | About 150 KB per installed version |
| Privileges | None. Everything installs under your user account. |
| Shell | bash, zsh, sh, PowerShell 5.1+, or cmd.exe |

The installer checks the Node version and stops if it is too old. It does not
install Node for you.

## What installation does not do

Installing this CLI does **not** install, start, or require:

- Ollama or any local AI runtime
- Docker, containers, or Kubernetes workloads
- databases or message queues
- background agents, daemons, services, cron jobs, or listening ports
- Python, compilers, or native build tools

Coderax inference, conversations, agents, and Work runs happen in the hosted
deployment. The CLI stores one small configuration file with the deployment URL
and an optional token. It makes HTTP requests and exits.

`package.json` has no `preinstall`, `install`, or `postinstall` script, and no
shipped module imports `node:child_process`. Both properties are enforced by
`npm run verify` and the test suite.

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

Replace `0.3.0` below with the release you are installing. The latest release is
listed at <https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases>.

> Release downloads require access to the repository. While the repository is
> private, only users with repository access can fetch these URLs; the same
> artifacts in `dist/` can be distributed internally.

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
against the release `SHA256SUMS`, extracts it to `~/.coderax/cli/$version`, and
symlinks `~/.local/bin/coderax` to the versioned launcher. Old versions stay in
place, which makes rollback a one-line change.

| Option | Default | Meaning |
| --- | --- | --- |
| `--version <x.y.z>` | `latest` | Release to install |
| `--prefix <dir>` | `~/.coderax/cli` | Install root; versions live below it |
| `--bin-dir <dir>` | `~/.local/bin` | Where the `coderax` launcher goes |
| `--from-file <path>` | — | Install a local tarball (air-gapped) |
| `--checksum <sha256>` | — | Required to verify `--from-file` |
| `--base-url <url>` | GitHub Releases | Releases mirror |
| `--force` | off | Replace an existing install of the same version |
| `--rollback` | off | Repoint the launcher to an installed version (needs `--version`) |
| `--no-completion` | off | Do not install shell completion |
| `--dry-run` | off | Print the plan and change nothing |
| `--skip-verify` | off | Skip checksum verification (not recommended) |

The installer never edits your shell profile. If `~/.local/bin` is not on
`PATH`, it prints the line to add.

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
`%LOCALAPPDATA%\Coderax\bin\coderax.cmd`. The installer does not change `PATH`;
it prints the command to add the launcher directory to your user `PATH`.

Options mirror the POSIX installer: `-Version`, `-Prefix`, `-BinDir`,
`-FromFile`, `-Checksum`, `-BaseUrl`, `-Force`, `-Rollback`, `-NoCompletion`,
`-CompletionDir`, `-DryRun`, `-SkipVerify`.

`-ExecutionPolicy Bypass` applies to that one process only. If your
organisation forbids it, unblock the file instead:
`Unblock-File .\install.ps1`.

## Option C — npm

The package is currently **not published**: `package.json` contains
`"private": true` so that publication is an explicit owner decision (see
[RELEASE.md](RELEASE.md)). Once publication is authorized:

```sh
npm install --global coderax-cli
# or pin a version
npm install --global coderax-cli@0.3.0
```

Today you can install a release tarball directly; it contains no dependencies,
so npm has nothing else to fetch:

```sh
npm install --global ./coderax-cli-0.3.0.tgz
```

To install into a project instead of globally:

```sh
npm install --save-exact ./coderax-cli-0.3.0.tgz
npx coderax --version
```

npm creates the `coderax` and `coderax.cmd` shims automatically. npm installs do
not add shell completion; print it with `coderax completion <shell>` and write it
to the path for your shell (see below).

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
# optional: put it on PATH
npm link
```

`npm ci` installs nothing at runtime; the lockfile records an empty dependency
tree. Do not run `npm install` with lifecycle scripts enabled for a checkout you
have not reviewed.

## Option E — air-gapped or offline

On a connected machine, download these five files from the release:

- `coderax-cli-<version>-standalone.tar.gz` (Linux/macOS) or
  `coderax-cli-<version>-standalone.zip` (Windows)
- `SHA256SUMS`
- `install.sh` or `install.ps1` (optional; the archive also contains them)

Transfer them, verify the checksums, then install without network access:

```sh
sh install.sh --version 0.3.0 \
  --from-file ./coderax-cli-0.3.0-standalone.tar.gz \
  --checksum "<sha256 from SHA256SUMS>"
```

Without the installer, extraction is enough:

```sh
tar -xzf coderax-cli-0.3.0-standalone.tar.gz -C "$HOME/.coderax/cli"
ln -sfn "$HOME/.coderax/cli/0.3.0/bin/coderax" "$HOME/.local/bin/coderax"
```

## First run

```sh
coderax config set --base-url https://coderax.example.com --token "<token>"
coderax doctor          # environment, config, reachability, engine compatibility
coderax compat          # explicit WorkflowEngine version verdict
coderax status
coderax chat "Summarize this repository"
```

`coderax login --token "<token>"` verifies the token against `/api/user` before
saving it. Environment variables (`CODERAX_BASE_URL`, `CODERAX_TOKEN`,
`CODERAX_TIMEOUT_MS`) take precedence over the file, which suits CI.

Remote deployments must use HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1`.

## Confirm the installation

```sh
coderax --version            # coderax-cli 0.3.0
coderax version --json       # machine-readable install report
coderax completion bash      # shell completion (also zsh, fish, powershell)
coderax help                 # command list
```

`coderax version --json` reports `cliVersion`, `node`, `platform`, `arch`,
`installMethod` (`standalone`, `npm-global`, `npm-local`, or `source`),
`installPath`, `configPath`, `clientApiVersion`, `clientApiMajor`, and `sdkVersion`.

## PATH setup

POSIX, if the installer reported that the launcher directory is not on `PATH`:

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

Open a new terminal afterwards.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Node.js is required but was not found` | Node missing from `PATH` | Install Node 24+ from <https://nodejs.org/> |
| `Node.js 24 or newer is required` | Older runtime | Upgrade Node; the CLI declares `>=24.0.0` |
| `checksum mismatch` | Truncated download, proxy, or tampering | Re-download; do not use `--skip-verify` |
| `version X is already installed` | Re-running the same version | Use `--force` to replace it |
| `coderax: command not found` | Launcher directory not on `PATH` | See PATH setup above |
| Completion does nothing | Shell has not loaded the generated file | Check the path and enable it as shown in [Shell completion](#shell-completion) |
| `BASE_URL_INSECURE` | Remote URL is `http://` | Use `https://`; HTTP is loopback-only |
| `HTTP_401` / `HTTP_403` | Missing, expired, or revoked token | `coderax login --token "<token>"` |
| `compat` says unsupported | Engine outside `>=0.8.0 <1.0.0` | See [COMPATIBILITY.md](COMPATIBILITY.md) |
| PowerShell refuses to run the script | Execution policy | Run with `-ExecutionPolicy Bypass` for that process |
| `install.sh: tar: not found` | Minimal container image | Install `tar`, or extract the archive another way |

## Next steps

- [UPGRADE.md](UPGRADE.md) — moving to a newer release without downtime
- [ROLLBACK.md](ROLLBACK.md) — returning to a previous version
- [COMPATIBILITY.md](COMPATIBILITY.md) — supported runtimes and engine versions
