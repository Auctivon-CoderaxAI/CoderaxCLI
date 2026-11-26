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
