# Security

## Credentials

- The token is stored at `~/.coderax/config.json` with mode `0600` when the
  operator runs `config set --token` or the `login` flow saves it; it is never
  written to logs or stdout.
- Writes go to a fresh `0600` temporary file and are atomically renamed over the
  config, so an existing world-readable file never receives the token even
  briefly. A failed rename or an unprotected temp file is an error, not a
  silent success.
- `config show` reports only `tokenConfigured: true|false`.
- `describeConfig` deliberately omits the token, and tests assert the string never
  appears in its output.
- Environment variables (`CODERAX_TOKEN`) take precedence, so CI can inject a
  short-lived token without writing a file.
- `coderax uninstall --yes` removes the stored credential file; it refuses
  obviously unsafe paths (the filesystem root, the home directory).

## Transport

Remote base URLs must be HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1`, matching the Coderax desktop client's policy. Credentials
embedded in a URL are rejected so a token cannot end up in shell history as part
of the URL.

## Redirects

`fetch` is called with `redirect: "error"`. A deployment that redirects to another
origin therefore produces an error rather than leaking the bearer token to a third
party.

## Output hygiene

Every output path is passed through `redact()` or `redactValue()`, which replace
the configured token with a marker. The marker is usually `[REDACTED]`, but it
uses `***` or another collision-safe value when the token shares characters with
`[REDACTED]`. Successful response text is returned in full after redaction;
only error diagnostics are truncated. JSON output stays valid and recursively
redacts both keys and values.

The installation test scans the combined output of every installed-CLI command
and fails if the bearer token appears anywhere.

## Timeouts

Every request has a timeout (default 15s, bound to 100–120000 ms) so a hung
deployment cannot block a pipeline indefinitely.

## Release integrity

- Every release publishes `SHA256SUMS` covering all assets, plus
  `release-manifest.json` with per-artifact and per-file hashes.
- `npm run verify` recomputes every checksum, parses both archives, and fails on
  any mismatch before an artifact can be published.
- `install.sh` and `install.ps1` verify the archive against the release
  `SHA256SUMS` by default and refuse to install on a mismatch. Verification can
  only be skipped explicitly (`--skip-verify` / `-SkipVerify`).
- Builds are reproducible: fixed metadata, sorted entries, fixed compression,
  and a fixed `SOURCE_DATE_EPOCH`. `npm run repro` proves that two builds from
  the same source produce identical hashes.
- An SPDX SBOM (`sbom.spdx.json`) records the package and its zero runtime
  dependencies.
- The release workflow refuses to publish when the tag and `package.json`
  version disagree, and refuses to overwrite an existing release.

Signing (Sigstore/cosign) is not enabled yet. Checksums, reproducible builds,
and SHA-pinned actions are the current mitigations; keyless signing can be added
without changing the artifact layout.

## Supply chain

- CI and release use standard GitHub-hosted runners only.
- Every third-party action is pinned to a commit SHA.
- `actions/checkout` uses `persist-credentials: false`, so the repository token
  is not left available to later steps.
- Pull-request workflows have `contents: read` and cannot reach the release
  workflow. There is no `pull_request_target`.
- `contents: write` exists only in the release job, which runs from a tag or a
  manual dispatch.
- npm publication, if ever enabled, uses OIDC trusted publishing with
  `id-token: write` and a protected environment. No long-lived npm token is
  stored in this repository.
- The package is `"private": true`; npm refuses to publish it until the owner
  explicitly authorizes publication.
- Dependency scanning: `npm audit --audit-level=high` runs in CI, Dependabot
  alerts and update PRs are enabled for npm and GitHub Actions, and CI fails if
  a runtime dependency appears. The runtime dependency tree is empty by design.
- `npm run verify` and the test suite fail if `package.json` gains a
  `preinstall`, `install`, or `postinstall` script, or if a shipped module
  imports `node:child_process`.

## Installation footprint

Installing Coderax CLI never installs, starts, or requires Node.js (the installer
only checks for it), Ollama, containers, local AI runtimes, databases, message
queues, background agents, or services listening on a port. The program is a
short-lived HTTP client and stores one configuration file.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Include the
CLI version (`coderax version --json`), platform, and the failing command with
its `coderax: <CODE>` output. Never include a live token.
