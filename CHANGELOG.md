# Changelog

## 1.0.0 — 2026-11-26

First complete standalone terminal client for the Coderax WorkflowEngine
contract `1.0.0`.

### Interactive terminal

- Chat and Work modes with persistent mode, conversation and agent/model
  selection.
- Streaming Markdown, fenced code, tables, tool calls, file edits, step
  progress, usage and approvals.
- Multiline prompts (blank-line mode or trailing backslash), command completion,
  input history and unread notification indicators.
- Conversation switching and session history backed by engine conversations.
- Inline permission approvals, cancellation, resume, retry, attachment and
  Ctrl+D detachment.

### Cloud Work

- Durable submission, status, list, watch, attach, report, cancel, resume,
  retry, resolve and uncertain-submission recovery.
- Engineering templates for repository inspection, implementation, tests,
  diff, PR preparation, review remediation and CI reproduction.
- Explicit capability checks for tools, durable tasks, resume and model
  selection; no local fallback execution.

### Reliability

- Contract negotiation at health time, with the reviewed engine OpenAPI
  artifact vendored and digest-checked offline.
- Real-engine integration tests run against the engine's own HTTP harness on a
  pinned commit in CI.
- Explicit task ids work from a terminal with no local journal.
- SSE reconnect with backoff and jitter, `after`/`Last-Event-ID` replay,
  event-id and sequence deduplication, gap detection and final status
  reconciliation.
- At-most-once Work submission with a persisted idempotency ledger.
- One-shot authentication refresh.
- `--json` and `--ndjson` output and the stable `0`–`10`/`130` exit-code table.

### Security

- Owner-token storage in macOS Keychain, Windows DPAPI or Linux Secret Service,
  with an explicit private-file fallback (`0600` where POSIX modes apply).
- Token redaction across text, JSON, Markdown and streamed deltas.
- HTTPS-only remote transport, redirect refusal, no anonymous owner access.
- Allowlisted child-process environment, no shell, token on stdin, bounded
  output and timeouts for credential helpers.
- No provider API keys read, printed, logged or inherited.

### Packaging

- Zero runtime dependencies; Node.js 24+.
- Pack verification for the real tarball, installed bin and dependency tree.
- Windows, macOS and Linux release archives with SHA256SUMS and installers.
- GitHub Actions CI on Ubuntu, Windows and macOS, a pinned engine contract job,
  and tag-driven GitHub release assets. No external registry publication.

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
