# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor release may change behaviour.

## [Unreleased]

### Added

- Authoritative WorkflowEngine 1.0.0 command namespace: `health`, `ready`,
  `compat`, `verify`, `agents`, `models`, `chat`, `work`, `task`, `tasks`,
  `events`, `cancel`, `resume`, `retry`, `conversations`, `conversation`,
  `memory`, `permissions`, `approve`, `deny`, `artifacts` (metadata),
  `notifications`, `status` and `capabilities`.
- One authoritative command registry for the engine surface, top-level dispatch
  validation, help, capability reporting and generated bash/zsh/fish
  completion (`coderax completion <shell>`).
- Contract gate: validate `/v1/health` `contractVersion` (1.0.x) before the
  owner token is sent; prove the token against `/v1/agents`; refuse redirects
  and unsupported contract lines.
- Live HTTP acceptance test against the built engine, including durable Work,
  SSE replay and fail-closed blocked commands; the CI workflow now runs it on
  Ubuntu against a pinned engine commit.
- Adopted the pinned engine contract, vendored OpenAPI digest, validated HTTP
  client, SSE decoder, event assembler and command handlers from
  `feat/engine-thin-client-v1` (`0cd85bf`); no second route catalogue,
  transport or handler layer is kept. `src/engine-commands.js` is a thin
  registry adapter with contract/owner preflight and secure credential
  handling.

### Changed

- Consolidated PR #6's release, authentication, durable-sync and packaging work
  into this branch; the engine namespace is layered on the release base rather
  than a parallel CLI.
- Replaced the branch's parallel engine handlers with the adopted
  `engine-surface.js`; Work now streams durable SSE events, pauses on approval,
  and reports authoritative task status and artifact metadata.
- Removed the superseded OpenAPI-discovery command catalog for commands the
  authoritative engine does not implement.

### Blocked

- Schedules, file transfers, plugins, tools, projects, execution lists, cloud
  browser, Native Game Studio and Native Gaming Agent are declared blocked
  because WorkflowEngine 1.0.0 has no such operations. They exit `6` without a
  request and are never simulated. Artifact metadata and notification-derived
  task discovery are available; `work --detach` is the supported detach path.

## [0.3.0] - 2026-11-26

This release reconciles three implementations that were developed in parallel:
the interactive terminal and autonomous Work client, durable task
synchronization, and release packaging. The artifact now contains all of them
together, rather than a packaging branch that shipped a stale CLI.

### Added

- Owner-only client: `whoami`, `tasks`, `workflows`, `runs`, `run`, `cancel`,
  `resume`, `retry`, `approve`, `repos`, autonomous `work submit`, conversation
  continuity, durable run monitoring, approvals, notifications and diagnostics.
- Shared SDK at `packages/workflow-sdk`: the authoritative API contract,
  transport, SSE decoder, sequencing, redaction and client. The CLI no longer
  owns a second copy of the protocol.
- `coderax compat` now reports two independent axes: the API-version handshake
  from the shared SDK (`1.x`) and the deployment version from OpenAPI
  `info.version` (`>=0.8.8 <1.0.0`). Compatible, incompatible, older,
  unavailable and unauthenticated states are tested separately.
- `coderax version --json` reports `supportedApiVersion`,
  `supportedDeploymentRange` and `compatibilityBasis`.
- Release engineering: deterministic build, reproducibility check, artifact
  verification, installation acceptance test, `SHA256SUMS`, SPDX SBOM, release
  manifest, offline installers and atomic upgrades.
- OS credential storage: Windows DPAPI and Linux Secret Service, both driven
  through stdin. `--token-file` reads a `0600` file without echoing it.
- Installer provenance verification with `--provenance` / `-Provenance`
  (`gh attestation verify`), alongside mandatory checksum verification.

### Changed

- A token is no longer accepted as a command-line argument. `--token` and
  `config set --token` are refused with exit `2`; authenticate through the
  hidden `coderax login` prompt, stdin, `--token-file`, or `CODERAX_TOKEN`.
- Installers no longer call `tar` or `Expand-Archive`. They embed the
  repository's safe extractor and reject absolute paths, `..`, symlinks,
  hardlinks, duplicate entries, writes through symlinked parents, and overwrites.
- Installs are staged, proven to report the expected version, then committed
  with a rename. A failed commit restores the previous directory, and `--force`
  retains a `.rollback-<version>-<timestamp>-<pid>` copy.
- `--from-file` now requires `--checksum` unless verification is explicitly
  skipped.
- The default npm test script uses Node's own glob handling so it behaves the
  same on Windows, macOS and Linux.
- The repository is documented as public; release downloads no longer require
  repository access.

### Fixed

- The previous release declared `>=0.8.0 <1.0.0` as a "WorkflowEngine" range
  read from `/health`, but the reference deployment returns plain text `OK`
  with no version and is `v0.8.8`; the separate `Coderax-WorkflowEngine` package
  is `0.1.0`. The range is now derived from the SDK handshake and the published
  deployment version, and unknown is never reported as compatible.
- Two Work SSE tests used doubly escaped newlines, so their fixtures never
  produced SSE frames. The fixtures now exercise the cumulative-snapshot
  handling they describe.
- Token handling no longer passes a secret through `argv`, shell history,
  process listings, installer arguments, or logs.

## [0.2.0] - 2026-11-26

### Added

- Release engineering for Windows, macOS and Linux: deterministic build,
  reproducibility check, artifact verification, installation test, checksums,
  SBOM and release manifest.
- `coderax version`, `compat`, `uninstall` and `update`.

## [0.1.0]

### Added

- Initial CLI: configuration with `0600` persistence, `login`/`logout`/`status`,
  chat and Work streaming, products, Cloud/project status, `doctor`, `health`,
  OpenAPI discovery, `agents`, `models`, and `call`.
- Token redaction, HTTPS enforcement with loopback exceptions, redirect refusal,
  and bounded request timeouts.
