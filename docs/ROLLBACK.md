# Rolling back Coderax CLI

Roll back when a new release breaks your automation, changes output your scripts
depend on, or reports an incompatible API or deployment version. Rolling back the
CLI does not touch deployment-side data: conversations, agents, Work runs and
tokens live in the Coderax deployment.

## 1. Identify the version to return to

```sh
coderax version --json
ls -1 "$HOME/.coderax/cli"
ls -1d "$HOME/.coderax/cli"/.rollback-* 2>/dev/null
```

Standalone installs keep versions side by side. A forced replace also keeps the
replaced directory as `.rollback-<version>-<timestamp>-<pid>` until you remove
it.

## 2. Roll back by installation method

### Standalone (Linux, macOS)

Repoint the launcher atomically with a temporary symlink and a rename:

```sh
target="$HOME/.coderax/cli/0.2.0/bin/coderax"
ln -s "$target" "$HOME/.local/bin/coderax.new"
mv -f "$HOME/.local/bin/coderax.new" "$HOME/.local/bin/coderax"
coderax --version
```

To restore a directory the installer moved aside:

```sh
prefix="$HOME/.coderax/cli"
backup="$(ls -1d "$prefix"/.rollback-0.3.0-* | tail -n 1)"
mv "$prefix/0.3.0" "$prefix/0.3.0.failed"
mv "$backup" "$prefix/0.3.0"
```

Then repoint the launcher as above.

If the old version was removed, reinstall it with its checksum:

```sh
sh install.sh --version 0.2.0
```

### Standalone (Windows)

Reinstall the old version; the installer rewrites `coderax.cmd` with a
same-volume move:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.2.0
coderax --version
```

A directory moved aside by `-Force` is named
`.rollback-<version>-<guid>` under the prefix and can be renamed back.

### npm

```sh
npm install --global ./coderax-cli-0.2.0.tgz
```

### Source

```sh
git checkout v0.2.0
npm ci --ignore-scripts
```

To select a version that is still installed, use `install.sh --rollback --version <version>`
or `install.ps1 -Rollback -Version <version>`. This repoints the launcher and
keeps the newer installation available.

## 3. Re-authenticate only if necessary

Credentials live outside the program directory. A rollback usually keeps you
signed in:

```sh
coderax status
coderax whoami
```

If the token was revoked or the old release cannot read the current config,
authenticate again without putting the token in argv:

```sh
coderax login                    # hidden prompt
printf '%s' "$TOKEN" | coderax login
```

## 4. Confirm the rollback

```sh
coderax --version
coderax version --json
coderax compat
coderax doctor
```

`compat` reports the API version and deployment version separately, so a rollback
that fixes a CLI regression does not hide a genuine deployment incompatibility.

## Cleanup

Once the rollback is confirmed, remove the failed version and old rollback
directories:

```sh
sh "$HOME/.coderax/cli/0.2.0/uninstall.sh" --version 0.3.0 --yes
rm -rf "$HOME/.coderax/cli"/.rollback-*
```

`coderax uninstall --dry-run` prints exactly what user data would be removed
before anything is deleted.
