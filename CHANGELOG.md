# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor release may change behaviour.

## [Unreleased]

### Added

- Canonical WorkflowEngine `/v1` transport in the shared SDK
  (`packages/workflow-sdk/src/v1/`): strict payload validation, contract
  negotiation that accepts any `1.x` and refuses another major, SSE replay with
  `Last-Event-ID` and `after`, `eventId` deduplication, `seq` gap detection,
  bounded reconnect with `STREAM_INTERRUPTED`, and durable at-most-once Work
  submission with `SUBMISSION_UNCERTAIN`. Legacy `/api` remains an explicit
  `CODERAX_SDK=workflow|legacy` migration mode and is never reached by a silent
  fallback from `v1`.
- `coderax v1` command group: `health`, `models`, `agents`, `chat`, `submit`,
  `task`, `watch`, `tasks`, `cancel`, `resume`, `retry`, `resolve`,
  `notifications`, `conversations`, `permissions` and `templates`. Chat and
  watch emit NDJSON under `--json`.
- Work templates (`inspect`, `implement`, `test`, `diff`, `pr`, `review`, `ci`)
  as engine objectives, with an explicit tool-capability refusal.
- Pinned contract artifact `contracts/workflow-engine-1.0.0.openapi.json` with
  provenance (engine commit `808dfd37`, SHA-256 `4be54dc9…`), verified by
  `test/v1-contract.test.js`.
- Exit codes `8` (approval required), `9` (submission uncertain) and `10`
  (conflict/busy), documented alongside the existing taxonomy.

### Fixed

- Windows secure-store hardened and verified ACLs through PowerShell module
  autoload, which failed when `USERPROFILE` was redirected and could be
  shadowed by a user-writable `PSModulePath`. The security module is now loaded
  from the interpreter's own directory, so a Unicode or redirected install path
  cannot make `login` fail with `CONFIG_PERMISSIONS`.
- The WorkflowEngine's `/v1/chat` is documented as SSE but implemented as JSON;
  the client accepts both and records the defect in `BACKEND-DEFECTS.md`.

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
- Interactive terminal: multiline composer, streaming markdown with syntax
  highlighting, bounded rendering, resize handling, command completion,
  model/agent/conversation selection, progress, tool activity, cancellation,
  retry/resume, accessible line mode and sanitised untrusted output.
- One command catalogue (`src/commands.js`) shared by CLI dispatch and terminal
  completion.
- The shared `packages/workflow-sdk` is the default terminal transport, so the
  interactive and non-interactive surfaces use one SSE parser.
- Windows ACLs are rewritten and verified by SID (locale- and domain-safe), and
  the DPAPI credential file is hardened and verified before use.

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
