# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor release may add or change behaviour.

## [Unreleased]

### Added

- `coderax engine` — durable task control over the authoritative
  Coderax-WorkflowEngine `/v1` contract 1.2.0: handshake negotiation, Work
  submission, task discovery, event replay/tailing, cancellation, resume,
  retry, permissions, notifications and reconciliation.
- Durable synchronization state partitioned by deployment origin, a one-way
  owner-token fingerprint and environment. Cursors and applied event ids are
  committed only after the event is handled; `eventId`/`seq` dedupe,
  `stream.truncated` snapshot recovery and bounded reconnects prevent duplicate
  output.
- Server-side `idempotencyKey` support. An ambiguous submission is never retried
  automatically; `--resume-key` reuses the engine reservation and returns the
  original task.
- Pinned engine contract and SDK provenance in `contracts/`, with a
  cross-repository verifier and an acceptance suite that runs against the real
  engine HTTP application.

### Changed

- The vendored `packages/workflow-sdk` is now marked as the temporary legacy
  `/api/*` compatibility adapter; the `/v1` engine client is the canonical
  client. No legacy command handler was rewritten.

### Known gaps

- WorkflowEngine PR #7 (contracts/SDK 1.2.0) is unmerged and the engine has no
  deployment. Acceptance runs on its in-process HTTP application, not a
  production origin.
- Contract 1.2.0 publishes no pause operation; the CLI does not invent one.
- OS keychain storage remains unimplemented.

## [0.3.0] - 2026-11-26

### Added

- Consolidated release pipeline for native Windows, macOS and Linux from one
  command registry and one CI workflow.
- Interactive Chat and Work, durable task synchronization, the reviewed
  WorkflowEngine SDK, workflows, runs, approvals, resume/retry, notifications
  and repository operations from the owner-authored capability branches.
- `coderax compat` and `coderax version --json` now report the SDK's pinned API
  contract (`API_VERSION`/`API_MAJOR`). The speculative engine semver range and
  `src/compat.js` are removed.
- Shell completion for bash, zsh, fish and PowerShell is generated from
  `src/command-registry.js`; a test fails if any command or flag is missing.
- `coderax uninstall`/`cleanup`, install/rollback documentation, release
  manifest, SPDX SBOM, SHA-256 checksums, reproducible builds and dependency
  scanning in CI.
- Installer hardening: archive traversal and symlink rejection, atomic launcher
  replacement, explicit downgrade refusal (`--allow-downgrade`), and paths with
  spaces and non-ASCII characters in the installed-artifact suite.

### Known gaps

- OS keychain/Credential Manager integration is not implemented; tokens use a
  `0600` config file or `CODERAX_TOKEN`.
- No live Coderax deployment was available, so live gateway integration is not
  verified. API negotiation is tested against contract stubs.
- The pinned SDK contract still needs confirmation from the WorkflowEngine SDK
  owner before production-compatibility claims.

## [0.2.0] - 2026-11-26

### Added

- Release engineering for Windows, macOS and Linux: deterministic build
  (`npm run build`), reproducibility check (`npm run repro`), artifact
  verification (`npm run verify`) and an automated installation test
  (`npm run install-test`).
- GitHub Release assets: npm-compatible tarball, POSIX standalone tarball,
  Windows standalone zip, `SHA256SUMS`, SPDX SBOM, release manifest, installers
  and uninstallers.
- `coderax version [--json]` reports the CLI version, Node runtime, platform,
  install method and install path.
- `coderax compat [--json]` compares the deployment's reported WorkflowEngine
  version with the supported range (`>=0.8.0 <1.0.0`).
- `coderax uninstall [--yes] [--purge]` removes user data and prints the
  program-removal commands for the detected install method.
- `coderax doctor` now reports the install method and WorkflowEngine
  compatibility.
- `coderax update` checks the GitHub release feed and prints upgrade commands
  for the detected install method. It never installs anything.
- `install.sh --rollback` and `install.ps1 -Rollback` repoint the launcher at a
  version that is already installed, without downloading or publishing anything.
- Shell completion for bash, zsh, fish and PowerShell: `coderax completion
  <shell>`. The standalone installers write the completion file for each shell
  they find (opt out with `--no-completion` / `-NoCompletion`), and the
  uninstallers remove only files carrying the generated-file marker.

### Changed

- `src/version.js` derives the version from `package.json`, so a release has a
  single version source.
- `update` no longer claims the package is unpublished; it reports the real
  release feed and degrades gracefully when it is unreachable.

### Fixed

- Two Work SSE tests used doubly escaped newlines, so their fixtures never
  produced SSE frames and the suite failed. The fixtures now exercise the
  cumulative-snapshot handling they describe.

## [0.1.0]

### Added

- Initial CLI: configuration with `0600` persistence, `login`/`logout`/`status`,
  chat and Work streaming, products, Cloud/project status, `doctor`, `health`,
  OpenAPI discovery, `agents`, `models`, and `call`.
- Token redaction across every output path, HTTPS enforcement with loopback
  exceptions, redirect refusal, and bounded request timeouts.
