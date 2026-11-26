# Rolling back Coderax CLI

Roll back when a new release breaks your automation, changes output your scripts
depend on, or reports an engine incompatibility. Rolling back the CLI does not
touch deployment-side data: conversations, agents, Work runs, and tokens live on
the Coderax deployment.

## 1. Identify the version to return to

```sh
coderax version --json
cat "$HOME/.coderax/cli"/*/package.json 2>/dev/null | grep '"version"'
```

Standalone installs keep every version under the install root, so the previous
version is usually still present.

## 2. Roll back by installation method

### Standalone (Linux, macOS)

Every installed version stays under the install root. Repoint the launcher and
refresh completion with one command:

```sh
sh install.sh --version 0.2.0 --rollback
coderax --version
```

If the old version was removed, reinstall it; the download is checksum-verified:

```sh
sh install.sh --version 0.2.0
```

Manual equivalent, if you prefer to relink yourself:

```sh
ln -sfn "$HOME/.coderax/cli/0.2.0/bin/coderax" "$HOME/.local/bin/coderax"
```

### Standalone (Windows)

The previous version directory is still under `%LOCALAPPDATA%\Coderax\cli`.
Repoint the launcher at it without downloading anything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.2.0 -Rollback
coderax --version
```

If that version is no longer on disk, reinstall it normally with `-Version
0.2.0` (the download is checksum-verified).

### npm

```sh
npm install --global coderax-cli@0.2.0      # published package
npm install --global ./coderax-cli-0.2.0.tgz  # release tarball
coderax --version
```

Remove a broken version first if npm refuses to overwrite the shims:
`npm uninstall --global coderax-cli`.

### Source checkout

```sh
git checkout v0.2.0
npm ci --ignore-scripts
node src/cli.js --version
```

## 3. Verify the rollback

```sh
coderax version --json
coderax doctor
coderax compat
coderax health
```

Expected: `cliVersion` is the version you chose, `installMethod` is unchanged,
`doctor` passes, and `compat` reports your deployment's engine inside the
older release's supported range.

If `doctor` fails only the `auth` check, sign in again:

```sh
coderax login --token "<token>"
```

## 4. Credentials and user data

Rollback does not change the config format. If you also need to reset local
state:

```sh
coderax logout                  # remove the stored token, keep settings
coderax uninstall --dry-run     # show what user data would be removed
coderax uninstall --yes         # remove the config file/directory
```

Backups taken before the upgrade can be restored:

```sh
cp "$HOME/.coderax/config.json.bak" "$HOME/.coderax/config.json"
chmod 600 "$HOME/.coderax/config.json"
```

## 5. Deployment-side notes

- The CLI is stateless apart from its config file. A rollback cannot corrupt
  deployment data.
- Tokens are issued and revoked by the deployment. If you suspect a token was
  exposed, revoke it there and log in with a new one; a CLI rollback is not a
  credential rotation.
- If the new CLI already wrote data through `coderax call`, reverse those
  changes through the same API. This CLI has no hidden local queue.

## 6. Record the incident

Note the CLI versions before and after, the deployment's engine version, the
failing command, and its exit code and `coderax: <CODE>` line. That is exactly
the information `coderax version --json` and `coderax doctor --json` provide.
