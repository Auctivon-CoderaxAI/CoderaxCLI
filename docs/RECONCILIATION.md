# Reconciliation record

This branch reconciles four lines of work against `main` at `1b7c8e0`. The
comparison below was made from the actual remote heads on 2026-11-26, not from
PR descriptions.

| Pull request | Remote head | Scope |
| --- | --- | --- |
| #4 `ci/fix-work-sse-fixtures` | `0932259` | 1 file, +7/−7: real newlines in the Work SSE fixtures |
| #5 `feat/owner-cloud-client-contract` | `5ca4d70` | 28 files, +5075/−423: owner client, shared workflow SDK, contract tests |
| #6 `freebuff/980c7f6b…` | `89c4038` | 57 files, +9748/−423: release 0.3.0, installers, shared SDK, workflow commands |
| feature branch | `d2c086d` | 46 files, +8324/−18: bounded interactive terminal, secure store, terminal tests |

The reconciled branch is based on PR #6's head, not on `main`, so its release
engineering, installers, shared SDK and contract tests are preserved rather
than copied. PR #6 advanced twice during this work (`327d3ea` → `90a4b0f` →
`89c4038`, both installer fixes); the final tree merges `89c4038`, so those
fixes are included rather than overwritten.

## Capability comparison

| Area | #4 | #5 | #6 | Feature branch | Reconciled decision |
| --- | --- | --- | --- | --- | --- |
| SSE fixture newlines | fixed | inherits | inherits | already applied | kept from #4 |
| Owner verification, durable runs, approvals | – | yes | yes | – | kept from #5/#6 |
| Shared SDK and SSE decoder | – | `packages/workflow-sdk` | same | separate legacy adapter | shared SDK is the default transport; legacy adapter is explicit compatibility only |
| Installers, signed-checksum verification, SBOM | – | – | yes | – | kept from #6 |
| Interactive terminal | – | – | inline `readline` loop in `workflow-commands.js` | `src/terminal/**`, `src/interactive.js` | feature implementation is authoritative; the inline loop was removed |
| Command catalogue | – | – | dispatch list in `cli.js` | second list in `terminal/completion.js` | `src/commands.js` drives both surfaces |
| Model/agent/conversation selection | – | – | – | yes | kept |
| Multiline editor, markdown, highlighting, resize | – | – | – | yes | kept |
| Prompt history and private storage | – | – | – | yes | kept |
| Attachment approval | – | – | – | yes | kept; transport declares `attachments: false` |
| ANSI/OSC/control sanitisation | – | – | – | yes | kept |
| Permission approval binding | – | approval policy for runs | – | server-bound broker | kept; legacy/shared transport fails closed |
| Windows ACLs | – | DPAPI | DPAPI | `secure-store.js` | SID-based rewrite and verification, DPAPI file hardened and verified |
| Real PTY tests | – | – | – | Linux/macOS via `script` | kept in CI; Windows console tests are separate |

## Authoritative choices

- **Terminal:** `src/terminal/session.js` plus `src/interactive.js`. PR #6's
  readline loop was deleted; `chat`/`work` now delegate to the same runner.
- **Command catalogue:** `src/commands.js`. `src/cli.js` derives its accepted
  command names from it and `src/terminal/completion.js` derives its slash
  commands from it. There is no second list.
- **Transport:** `packages/workflow-sdk` (contract, HTTP, SSE, sequencing,
  redaction, `WorkflowClient`) is the production parser. `src/workflow-transport.js`
  adapts it to the terminal's event vocabulary. `src/sdk.js` still implements
  the verified canonical-`@coderax/sdk` gate; `src/sdk-legacy.js` is reachable
  only with `CODERAX_SDK=legacy`.
- **Release:** PR #6's build, verify, reproducibility and install-acceptance
  scripts are unchanged. CI now runs them on Ubuntu, Windows and macOS and adds
  the real-PTY job for Ubuntu and macOS.
- **Windows storage:** private paths are verified by SID. The DACL is rebuilt
  with inheritance disabled and a single allow entry for the current account.
  Display names are never matched, so localized and domain accounts behave
  correctly. DPAPI ciphertext is additionally ACL-hardened and verified.

## Evidence collected locally

- `npm run check`: 94 JavaScript and MJS files pass `node --check`.
- `npm test`: 363 tests, 361 pass, 0 fail, 2 skipped. The skips are the two
  Windows-only tests, which require an actual Windows runner. The suite now
  includes the shared `/v1` contract, client, stream, submit, transport,
  interactive-session and CLI suites.
- `npm run test:pty`: real pseudo-terminal on Linux; raw mode, 40-column
  resize, CJK/emoji editing, streamed markdown, Ctrl+C cancellation and clean
  exit. The same job is configured for macOS.
- `npm run build`: deterministic npm tarball, standalone tarball, zip,
  `SHA256SUMS`, SPDX SBOM and release manifest.
- `npm run verify`: tarball contents, checksums, installer safety, spawn
  allowlist and documented files.
- `npm run install-test`: 20/20 checks on Linux, including install into a path
  with spaces and Unicode, hostile archives, SSE through the installed
  launcher, rollback, credential-leak scanning and uninstall. The Windows
  hosted acceptance run is the release gate; its failure and fix are recorded
  below.

## Hosted verification status

- The CI workflow runs the full Ubuntu, Windows and macOS matrix for pushes to
  `main` and `rc/**`; pull requests run Ubuntu only to keep the private-repo
  cost bounded. A release candidate therefore gets cross-platform acceptance at
  its exact SHA without weakening the matrix on `main`.
- The Windows unit, terminal, ACL and secure-store suites pass on the hosted
  runner. Windows hosted installation acceptance now fails only when PowerShell
  cannot autoload its security module; the store pins `PSModulePath` to the
  interpreter's own `Modules` directory, and the hosted acceptance run is the
  gate for that fix.
- macOS unit and real-PTY jobs pass on the hosted runner. That is execution of
  the tests, not a live Keychain integration test: the macOS credential unit
  tests inject the platform, so genuine Keychain behaviour remains unverified.

## Not verified here, and why

1. **A deployed WorkflowEngine endpoint and owner token.** No production URL or
   credential was provided. The `/v1` transport is tested against its pinned
   OpenAPI document and a fixture engine, not a live cloud deployment. No claim
   of production connectivity is made until an authorized endpoint is supplied.
2. **Windows installer acceptance at the final SHA.** The PowerShell module
   autoload defect is fixed and covered by a unit test, but the Windows hosted
   acceptance job must pass at the exact release-candidate SHA. A green Linux
   run is not evidence for Windows.
3. **Upstream engine version drift.** The pinned contract is engine commit
   `808dfd37` and version `1.0.0`. Negotiation accepts any `1.x`; it rejects a
   different major. If the WorkflowEngine publishes a new minor while this is in
   review, the pin and provenance must be refreshed with a reviewed contract
   diff rather than silently widening the accepted shapes.
4. **Artifacts and scheduled tasks.** The WorkflowEngine OpenAPI document
   exposes health, readiness, agents, models, chat, work, tasks, events,
   conversations, memory, permissions and notifications. It has no artifact or
   scheduled-task routes. The CLI refuses those operations explicitly instead of
   inventing an endpoint. Attachments are likewise refused: `/v1` publishes no
   upload operation.
5. **Independent human approval.** A coding agent cannot supply the required
   human review. This branch is an integration candidate for the owner, not a
   competing release and not a tag.

No tag, package publication, production change or direct `main` push was made.
