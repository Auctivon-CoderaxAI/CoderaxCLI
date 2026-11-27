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

## Terminal output

All untrusted text (model output, tool names, resources, file names) passes
through `src/terminal/sanitize.js` before measurement or rendering. CSI, OSC
(including OSC 52 clipboard writes and window titles), DCS, APC, PM, SOS, C0/C1
controls, DEL, bidi overrides and lone surrogates are removed. The sanitiser is
stateful, so an escape sequence split across two SSE deltas is still removed.
Model text never supplies ANSI bytes: markdown produces style *names* and the
theme decides the bytes. Bracketed paste is bounded and control characters are
stripped.

## Permission approvals

An approval is shown only when the request arrives on a verified server channel
and carries a server-issued request id, execution identity, allowed action and
concrete resource. The CLI rejects model-generated or malformed requests and
never prompts for them. Approval echoes the exact request id, execution id,
action and SHA-256 resource hash. A session grant is scoped to that exact
action, resource and execution and is dropped when the execution ends; there is
no blanket "allow all". If delivery of an approval fails, the CLI treats it as a
denial and cancels the response. The legacy transport has no verified approval
channel, so permission requests there fail closed.

## Local files

`@path` references are not read automatically. Each file is resolved without
following symlinks, checked against a sensitive-path denylist (`.env`, keys,
credential stores, `.git`, `.coderax`, and similar), confined to the working
directory by default, size-limited, checked for binary content, hashed, and
shown to the operator for an explicit per-send approval. Declining sends
nothing. Symlink following and out-of-directory access require explicit
environment opt-ins and still require approval. File content is never written
to history or logs.

## Prompt history

`history.json` lives beside the config and contains prompts only: never
responses, tool output or file contents. Prompts matching secret patterns or
containing local-file references are skipped. Retention and maximum entry count
are configurable; `history clear` deletes the file and `history off` deletes it
and disables conversation metadata persistence. `--no-history` disables both for
one run.

## Platform file permissions

`src/secure-store.js` verifies rather than assumes. POSIX files must be mode
`0600` and owned by the current uid, directories `0700`; macOS ACLs are checked
with `ls -le`; Windows ACLs are rewritten so that inheritance is removed and
only the current account's SID is granted, then verified by SID. Any remaining
access entry for another principal is rejected, including localized names for
Everyone, Users and Authenticated Users. Verification failure is an error, and
the config writer performs the same check after its atomic rename. A missing or
unverifiable ACL tool fails closed.

## Timeouts

## Release integrity

- Every release publishes `SHA256SUMS` covering all assets, plus
  `release-manifest.json` with per-artifact and per-file hashes.
- `npm run verify` recomputes every checksum, parses both archives, and fails on
  any mismatch before an artifact can be published.
- `install.sh` and `install.ps1` verify the archive against the release
  `SHA256SUMS` by default and refuse to install on a mismatch. `--from-file`
  requires `--checksum` unless verification is explicitly disabled.
- `--provenance` / `-Provenance` (or `CODERAX_REQUIRE_PROVENANCE=1`) verifies
  the archive with Cosign against the CoderaxCLI release workflow and the
  GitHub Actions OIDC issuer. When no bundle exists, the installer requires
  a valid GitHub attestation for legacy releases. Verification failure stops
  installation.
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

`coderax engine` uses the same owner credential settings and refuses tokens in
argv. It verifies login against the owner protected engine agent route. Its
HTTP client rejects redirects and sends the bearer token only to the configured
deployment.
