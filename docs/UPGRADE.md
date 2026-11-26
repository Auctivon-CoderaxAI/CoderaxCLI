# Upgrading Coderax CLI

Coderax CLI never upgrades itself. `coderax update` checks the GitHub release
feed and prints the commands that apply to your installation method; running
them is your decision. This is deliberate: a network client that silently
replaces its own executable is a supply-chain risk and is impossible to audit.

## Before you upgrade

```sh
coderax version --json > version-before.json
coderax update                 # current vs latest, plus exact commands
coderax doctor                 # note reachability and engine compatibility

cp "$HOME/.coderax/config.json" "$HOME/.coderax/config.json.bak"   # optional
```

Read the target release notes (`CHANGELOG.md` in the repository, or the release
page). Releases follow semantic versioning:

| Change | Version bump |
| --- | --- |
| Bug fix, redaction fix, documentation | patch (`0.2.0` → `0.2.1`) |
| New command, new flag, new API contract | minor (`0.2.x` → `0.3.0`) |
| Breaking CLI or config change | major (after `1.0.0`) |
| Security fix | patch, with an advisory |

The pinned API contract is reported by `coderax version --json` as
`clientApiVersion` and `clientApiMajor`; `coderax compat` negotiates it with the
deployment.

## Standalone installs (Linux, macOS, Windows)

New versions install side by side; the launcher is repointed to the new version
and the previous one stays on disk.

```sh
# Linux / macOS
sh install.sh --version 0.3.0
coderax --version
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.3.0
coderax --version
```

The installer verifies the release checksum before extracting. If you installed
to a custom location, pass the same `--prefix`/`--bin-dir` (or `-Prefix`/
`-BinDir`) values you used originally. `coderax version --json` reports
`installPath` if you are unsure.

Upgrading does **not** require `--force`; that flag only replaces an existing
installation of the *same* version. The installer also refreshes shell completion
for the shells it finds, so completion keeps matching the active version.

### Offline upgrades

```sh
sh install.sh --version 0.3.0 \
  --from-file ./coderax-cli-0.3.0-standalone.tar.gz \
  --checksum "<sha256 from SHA256SUMS>"
```

## npm installs

Once the package is published (see [RELEASE.md](RELEASE.md)):

```sh
npm install --global coderax-cli@0.3.0     # pin explicitly
npm view coderax-cli versions --json       # list published versions
```

For a project-local install, keep the exact version in `package.json`:

```sh
npm install --save-exact coderax-cli@0.3.0
```

From a release tarball (works today, no registry required):

```sh
npm install --global ./coderax-cli-0.3.0.tgz
```

## Source checkouts

```sh
git fetch --tags
git checkout v0.3.0
npm ci --ignore-scripts
node src/cli.js --version
```

`npm ci` is used instead of `npm install` so the lockfile is authoritative and
no lifecycle scripts run.

## Verify after any upgrade

```sh
coderax version --json     # cliVersion and installMethod are what you expect
coderax doctor             # node, config, reachability, engine compatibility
coderax compat             # WorkflowEngine range verdict
coderax status             # deployment URL, auth, install path
coderax health             # one authenticated request end to end
```

If `doctor` reports the engine check as unsupported, the CLI is newer or older
than your deployment's engine allows. Check the matrix in
[COMPATIBILITY.md](COMPATIBILITY.md), then either upgrade the deployment or
install a CLI release that supports the reported engine version.

## Configuration compatibility

- The config file (`~/.coderax/config.json`, mode `0600`) is written
  atomically and only gains keys between releases.
- Unknown keys are preserved on write, so downgrading does not discard settings
  written by a newer CLI.
- Environment variables (`CODERAX_BASE_URL`, `CODERAX_TOKEN`,
  `CODERAX_TIMEOUT_MS`, `CODERAX_CONFIG`) always win over the file.
- A token is never printed by any command, including `--json` output.

If a release ever needs a config migration, it will be documented here and in
the release notes with an explicit before/after example.

## Automation

Pin the exact version in CI and upgrade deliberately:

```sh
npm install --global coderax-cli@0.2.0
# or, from artifacts
sh install.sh --version 0.2.0 --prefix "$RUNNER_TEMP/coderax" --bin-dir "$RUNNER_TEMP/bin"
export PATH="$RUNNER_TEMP/bin:$PATH"
```

`coderax update` exits `0` even when the release feed is unreachable and says so
in its output, so it is safe to run as a diagnostic without failing a pipeline.

## Rolling back

See [ROLLBACK.md](ROLLBACK.md). Standalone installs keep prior versions, so a
rollback is one command: `sh install.sh --version 0.2.0 --rollback` (Windows:
`-Rollback`).
