# Upgrading Coderax CLI

Coderax CLI never upgrades itself. `coderax update` checks the GitHub release
feed and prints the commands that apply to your installation method; running
them is your decision. A network client that silently replaces its own
executable is a supply-chain risk and impossible to audit.

## Before you upgrade

```sh
coderax version --json > version-before.json
coderax update                 # current vs latest, plus exact commands
coderax doctor                 # reachability, API version and deployment version
```

Releases follow semantic versioning. While the major version is `0`, a minor
release may change behaviour.

| Change | Version bump |
| --- | --- |
| Bug fix, redaction fix, documentation | patch |
| New command, new flag, wider deployment range | minor |
| Breaking CLI or config change | major (after `1.0.0`) |
| Security fix | patch, with an advisory |

`coderax version --json` reports the contract each release implements:
`supportedApiVersion` and `supportedDeploymentRange`. Both are derived from the
shared SDK and the published deployment version, not guessed.

## Standalone installs (Linux, macOS, Windows)

```sh
# Linux / macOS
sh install.sh --version 0.3.0 --provenance
coderax --version
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.3.0 -Provenance
coderax --version
```

The upgrade is atomic:

1. the archive is checksum-verified (and provenance-verified with
   `--provenance`),
2. it is extracted with the safe extractor into a staging directory,
3. the staged `coderax` is executed and must report the expected version,
4. an existing same-version directory is moved to
   `<prefix>/.rollback-<version>-<timestamp>-<pid>`,
5. the staged tree is moved into place with a rename,
6. the launcher is replaced with `rename(2)`, not unlink + symlink.

If step 5 or 6 fails, the previous directory is restored and the installer exits
non-zero. A failed upgrade therefore cannot leave you without a working CLI.

New versions normally install side by side; the launcher is repointed and the
old version stays on disk. `--force` is only needed to replace an existing
installation of the *same* version.

### Offline upgrades

```sh
sh install.sh --version 0.3.0 \
  --from-file ./coderax-cli-0.3.0-standalone.tar.gz \
  --checksum "<sha256 from SHA256SUMS>"
```

## npm

```sh
npm install --global ./coderax-cli-0.3.0.tgz
```

Registry publication is not enabled; `package.json` remains `"private": true`
until the owner authorizes it.

## Source checkout

```sh
git fetch --tags
git checkout v0.3.0
npm ci --ignore-scripts
```

## Credentials survive an upgrade

The config file and OS credential entry are independent of the program
directory, so a normal upgrade does not require signing in again. If you use a
custom `CODERAX_CONFIG`, pass the same environment to the new version.

A token is never passed to the installer or to an upgrade command. Authenticate
after upgrading with `coderax login` (hidden prompt), stdin, `--token-file`, or
`CODERAX_TOKEN`.

## Verifying the upgrade

```sh
coderax --version
coderax version --json
coderax doctor
coderax compat
```

`installPath` in `version --json` shows which directory is running, and
`installMethod` distinguishes `standalone`, `npm-global`, `npm-local` and
`source`.
