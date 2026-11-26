# Reconciliation record

This branch reconciles four lines of work against `main` at `1b7c8e0`. The
comparison below was made from the actual remote heads on 2026-11-26, not from
PR descriptions.

| Pull request | Remote head | Scope |
| --- | --- | --- |
| #4 `ci/fix-work-sse-fixtures` | `0932259` | 1 file, +7/−7: real newlines in the Work SSE fixtures |
| #5 `feat/owner-cloud-client-contract` | `5ca4d70` | 28 files, +5075/−423: owner client, shared workflow SDK, contract tests |
| #6 `freebuff/980c7f6b…` | `327d3ea` | 57 files, +9704/−423: release 0.3.0, installers, shared SDK, workflow commands |
| feature branch | `d2c086d` | 46 files, +8324/−18: bounded interactive terminal, secure store, terminal tests |

The reconciled branch is based on PR #6's head, not on `main`, so its release
engineering, installers, shared SDK and contract tests are preserved rather
than copied.

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

- `npm run check`: 76 JavaScript and MJS files pass `node --check`.
- `npm test`: 294 tests, 292 pass, 0 fail, 2 skipped. The skips are the two
  Windows-only tests, which require an actual Windows runner.
- `npm run test:pty`: real pseudo-terminal on Linux; raw mode, 40-column
  resize, CJK/emoji editing, streamed markdown, Ctrl+C cancellation and clean
  exit. The same job is configured for macOS.
- `npm run build`: deterministic npm tarball, standalone tarball, zip,
  `SHA256SUMS`, SPDX SBOM and release manifest.
- `npm run verify`: tarball contents, checksums, installer safety, spawn
  allowlist and documented files.

## Not verified here, and why

1. **Hosted CI at the final SHA.** This environment cannot create the pull
   request or trigger workflows: `gh` is absent, no GitHub token is available,
   and `cloud_git` supports fetch/pull/push only. The workflow triggers on
   pull requests and `main` pushes, so a branch push alone produces no run.
   PR #5's body also reports an organization Actions billing/runner failure.
2. **Windows and macOS execution.** Only the Linux host is available. The
   Windows ACL and console tests are written and included in `npm test`; they
   skip elsewhere. No claim is made that they passed.
3. **Authoritative WorkflowEngine `/v1` integration.** The public
   `Auctivon-CoderaxAI/Coderax-WorkflowEngine` repository defines contract
   `1.0.0` under `/v1` and publishes `@coderax/sdk` as a private TypeScript
   package. PR #6's `packages/workflow-sdk` is explicitly written against the
   deployment's legacy `/api/work` and `/api/workflows` routes. The two are not
   interchangeable. Until the `/v1` SDK is published (or vendored under an
   approved policy), the CLI must not claim WorkflowEngine connectivity, and
   the canonical gate stays closed.
4. **Artifacts and scheduled tasks.** The WorkflowEngine OpenAPI document
   exposes health, readiness, agents, models, chat, work, tasks, events,
   conversations, memory, permissions and notifications. It has no artifacts or
   scheduled-task routes. Implementing those terminal panels would require
   inventing an endpoint, which the contract explicitly forbids.
5. **PR #6 owner coordination and independent approval.** A coding agent cannot
   contact the owner or provide a human review. This branch is an integration
   candidate for PR #6's owner, not a competing release and not a tag.

No tag, package publication, production change or `main` push was made.
