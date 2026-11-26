> **Private-repository note (GitHub Free):** GitHub artifact attestations are
> public-repository-only on Free. Releases are signed with keyless Sigstore and
> publish a `.sigstore.json` bundle next to each asset; verify with
> `cosign verify-blob --bundle …`. npm provenance is also public-only and is not
> produced from a private repository.

# Security

## Credentials

A bearer token is a secret. The CLI therefore never accepts one as a command-line
argument: `--token` is refused with exit `2`, because argv is recorded in shell
history, visible in process listings, and copied into CI logs.

Accepted sources, in order:

1. `coderax login` at a terminal: the prompt disables echo.
2. `coderax login` with a non-TTY stdin, for CI: `printf '%s' "$TOKEN" | coderax login`.
3. `--token-file <path>`: the file must be a regular file with no group/other
   permission bits (`0600`). The value is read, never echoed.
4. `CODERAX_TOKEN` in the environment, for ephemeral CI credentials.

### Storage

| Platform | Store | Why |
| --- | --- | --- |
| Windows | DPAPI through PowerShell, secret on stdin | Encrypted to the user account without argv exposure |
| Linux | Secret Service through `secret-tool`, secret on stdin | Default desktop keyring, non-argv interface |
| Linux without `secret-tool` | `0600` config file | Explicit fallback; the CLI prints a warning |
| macOS | `0600` config file | `security add-generic-password` requires the password as an argument; using it would leak the token into argv |

Set `CODERAX_CREDENTIAL_STORE=file` to force the file store, or `os` to require
the platform store. The config file holds only metadata when an OS store is used
(`tokenStore` names the backend), so copying it does not copy the credential.

File writes go to a fresh `0600` temporary file and are atomically renamed over
the config, in a `0700` directory, and refuse a symlinked config path. Reading a
credential file that is group/world-readable is an error, not a warning.
`coderax uninstall --yes` removes the stored credential, including the OS-store
entry; `coderax logout` clears it from whichever backend stored it.

Other properties:

- `config show` reports only `tokenConfigured: true|false`.
- `describeConfig` omits the token, and tests assert it never appears.
- `coderax status --json` reports a masked token only.

## Transport

Remote base URLs must be HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1`. Credentials embedded in a URL are rejected so a token
cannot end up in shell history as part of the URL.

`fetch` is called with `redirect: "error"`. A deployment that redirects to
another origin produces an error rather than leaking the bearer token.

## Output hygiene

Every output path passes through `redact()` or `redactValue()`, which replace the
configured token with a marker. The marker is usually `[REDACTED]`, but it uses
`***` or another collision-safe value when the token shares characters with
`[REDACTED]`. Streaming redaction holds a token prefix across deltas and releases
it safely at the end of the stream. JSON output stays valid and recursively
redacts keys and values.

The installation test scans the combined output of every installed-CLI command
and fails if the bearer token appears anywhere.

## Release integrity

- Every release publishes `SHA256SUMS` covering all assets, plus
  `release-manifest.json` with per-artifact and per-file hashes.
- `npm run verify` recomputes every checksum, parses both archives, and fails on
  any mismatch before an artifact can be published.
- `install.sh` and `install.ps1` verify the archive against the release
  `SHA256SUMS` by default and refuse to install on a mismatch. `--from-file`
  requires `--checksum` unless verification is explicitly disabled.
- `--provenance` / `-Provenance` (or `CODERAX_REQUIRE_PROVENANCE=1`) runs
  `gh attestation verify` against the repository. This is opt-in because the
  release workflow does not publish attestations until the owner authorizes a
  release; checksums are always enforced.
- Builds are reproducible: fixed metadata, sorted entries, fixed compression and
  a fixed `SOURCE_DATE_EPOCH`. `npm run repro` proves two builds are identical.
- An SPDX SBOM (`sbom.spdx.json`) records the package and its zero runtime
  dependencies.
- The release workflow refuses to publish when the tag and `package.json`
  version disagree, and refuses to overwrite an existing release.

### Archive extraction

The installers never call `tar` or `Expand-Archive`. They embed the repository's
own extractor (`scripts/lib/safe-extract.mjs`, built into both installers at
release time and compared byte-for-byte by `npm run verify`), which refuses:

- absolute paths, drive letters, UNC paths, backslashes and NUL bytes,
- `.` or `..` segments and empty segments,
- every entry type other than a regular file, including symlinks and hardlinks,
- duplicate entries,
- destination paths outside the requested directory, including through a
  pre-existing symlinked parent,
- any existing file at a destination path (no overwrite).

### Atomic upgrade and rollback

An install is extracted into a staging directory, its launcher is executed to
prove it reports the expected version, and only then is it moved into place. An
existing same-version directory is moved aside first and restored if the final
move or the launcher swap fails. The launcher itself is replaced with
`rename(2)`, not an unlink followed by a symlink.

## Supply chain

- CI and release use standard GitHub-hosted runners only.
- Every third-party action is pinned to a commit SHA.
- `actions/checkout` uses `persist-credentials: false`.
- Pull-request workflows have `contents: read` and cannot reach the release
  workflow. There is no `pull_request_target`.
- `contents: write` exists only in the release job, which runs from a tag or a
  manual dispatch.
- npm publication, if enabled, uses OIDC trusted publishing with
  `id-token: write` and a protected environment. No long-lived npm token is
  stored in this repository.
- The package is `"private": true`; npm refuses to publish it until the owner
  explicitly authorizes publication.
- Dependency scanning: `npm audit --audit-level=high` runs in CI, Dependabot
  alerts and update PRs are enabled, and CI fails if a runtime dependency
  appears.
- `npm run verify` and the test suite fail if `package.json` gains a
  `preinstall`, `install`, or `postinstall` script, or if a shipped module
  imports `node:child_process` without a documented guard. Only
  `credentials.js` (fixed OS helper) and `workflow-commands.js` (operator-supplied
  `--notify-command`) are allowlisted.

## Installation footprint

Installing Coderax CLI never installs, starts, or requires Node.js (the installer
only checks for it), Ollama, containers, local AI runtimes, databases, message
queues, background agents, or services listening on a port. The program is a
short-lived HTTP client and stores one small configuration file.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Include the
CLI version (`coderax version --json`), platform, and the failing command with
its `coderax: <CODE>` output. Never include a live token.
