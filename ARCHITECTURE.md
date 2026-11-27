# Architecture

```
argv ──► parseArgv ──► preflight ──► resolveSettings ──► dispatch
                          │              │                 │
                    usage errors    config.js        product commands
                    (exit 2)     (env + 0600 file)   (login, status, doctor)
                                                          │
                                          ┌───────────────┴───────────────┐
                                          ▼                               ▼
                                  workflow-commands.js              discover.js
                                  (chat, work, runs,                (OpenAPI)
                                   approvals, notifications)
                                          │
                                          ▼
                                  packages/workflow-sdk
                                  contract · http · sse · client
                                          │
                                          ▼
                                  fetch (HTTPS, no redirects)

The interactive terminal is a presentation layer over the same transport:

interactive.js ─► terminal/session.js ─► sdk.js ─► workflow-transport.js
                        │                 │        └─► packages/workflow-sdk (legacy /api SSE)
                        │                 ├─► v1-transport.js ─► packages/workflow-sdk/src/v1
                        │                 ├─► sdk-legacy.js (explicit only)
                        │                 └─► @coderax/sdk (verified only)
                        ├─► terminal/renderer.js ─► terminal/editor.js
                        ├─► terminal/markdown.js ─► terminal/highlight.js
                        ├─► terminal/permissions.js
                        └─► terminal/attachments.js
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/cli.js` | parsing, preflight, dispatch, exit-code mapping, top-level errors | every command module |
| `src/config.js` | resolve, validate, atomically persist settings; 0600/0700; symlink refusal; sessions; role; delegates the token to the credential store | filesystem, environment, credentials |
| `src/credentials.js` | OS credential storage (DPAPI, Secret Service), token files, non-argv secret input | fixed OS helpers |
| `src/product-commands.js` | owner login/logout/whoami/status, doctor, `compat`, `update`, legacy discovery commands | SDK, config, credentials, discovery |
| `src/compat.js` | two-axis compatibility: SDK API handshake plus deployment `info.version` | SDK, discovery |
| `src/diagnostics.js` | install method, version and compatibility contract | filesystem, compat |
| `src/maintenance.js` | uninstall/cleanup of user data and program-removal guidance | filesystem |
| `src/workflow-commands.js` | chat, Work, autonomous submit, tasks, runs, approvals, cancel/resume/retry, notifications | SDK, session, render, approval |
| `src/v1-commands.js` | `coderax v1` surface: login/whoami, health, discovery, chat, submit, watch, task control, resolve, notifications, conversations, permissions, templates | shared SDK `/v1` |
| `src/v1-transport.js` | maps `/v1` execution events onto the terminal vocabulary; honest capabilities | shared SDK `/v1`, client |
| `src/submissions.js` | durable, private, per-deployment submission ledger | secure-store, config |
| `src/session.js` | per-deployment conversation continuity, bounded and normalized | none |
| `src/render.js` | human tables and run rendering | none |
| `src/approval.js` | fail-closed approval policies | SDK |
| `src/discover.js` | OpenAPI discovery for `openapi`/`agents`/`models` | HTTP client |
| `packages/workflow-sdk/src/contract.js` | routes, capabilities, statuses, documented backend gaps | none |
| `packages/workflow-sdk/src/http.js` | transport, SSE content-type enforcement, version header, idle timeout, cancellation | `fetch` |
| `packages/workflow-sdk/src/sse.js` | SSE decoder, event sequencing, deduplication, gap handling | none |
| `packages/workflow-sdk/src/client.js` | owner check, negotiation, chat, runs, builds, approvals, cancellation | contract, http, sse |
| `packages/workflow-sdk/src/v1/contract.js` | pinned `/v1` route catalogue and strict payload/event validators | none |
| `packages/workflow-sdk/src/v1/client.js` | `/v1` requests, negotiation, SSE chat and event replay | v1 contract, http, sse |
| `packages/workflow-sdk/src/v1/stream.js` | durable task tailing: dedupe, gap detection, bounded reconnect | v1 contract |
| `packages/workflow-sdk/src/v1/submit.js` | at-most-once submission over an injected ledger; uncertainty handling | v1 contract |
| `packages/workflow-sdk/src/redact.js` | streaming and recursive token redaction | none |
| `src/client.js` | one HTTP request, error mapping, redaction | `fetch` only |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/commands.js` | canonical command catalogue for CLI dispatch and terminal completion | none |
| `src/sdk.js` | interactive transport facade: canonical `/v1`, shared legacy SDK, verified `@coderax/sdk` gate | shared SDK, legacy adapter |
| `src/workflow-transport.js` | terminal adapter over the shared workflow SDK | `packages/workflow-sdk` |
| `src/sdk-legacy.js` | explicit compatibility SSE adapter | client, discovery |
| `src/interactive.js` | TTY raw mode, resize, accessible input | terminal modules, sdk |
| `src/terminal/session.js` | interactive Chat/Work orchestration | renderer, editor, stores |
| `src/terminal/renderer.js` | prompt region, bounded block, accessible output | text, theme |
| `src/terminal/markdown.js` | streaming markdown, highlighting, preview | sanitize, text, highlight |
| `src/terminal/editor.js` | grapheme-safe multiline editing | text |
| `src/terminal/keys.js` | key/paste parsing | none |
| `src/terminal/history.js` | prompt and conversation metadata storage | secure-store |
| `src/terminal/permissions.js` | verified approval binding | sanitize |
| `src/terminal/attachments.js` | explicit local-file review | sanitize |
| `src/secure-store.js` | cross-platform private file verification | OS ACL tools |

The SDK is imported by relative path. There is no workspace install step, no
npm dependency and no duplicate backend implementation inside the CLI.

## Credentials

`credentials.js` is the only module allowed to handle a secret before it reaches
the config layer. It never puts a token in `argv`: Windows DPAPI and Linux
Secret Service are driven through stdin, and the macOS Keychain is deliberately
not used because its CLI requires the password as an argument. When no OS store
is available the token goes into the `0600` config file and the CLI says so.

## Release engineering

`scripts/build-release.mjs` produces deterministic npm, POSIX and Windows
artifacts, embeds the safe extractor into both installers, and writes the
manifest, checksums and SPDX SBOM. `verify-release.mjs` re-checks every hash and
the embedded extractor. `install-test.mjs` installs the packed artifacts and
exercises hostile archives, secure auth, every compatibility state, streaming,
atomic upgrade and uninstall. `repro-check.mjs` proves two builds are identical.

## Streams

### Chat

`POST /api/work/chat` is a single, non-retryable request. The SDK accepts
cumulative snapshots (`message`, `type:"text"`) and deltas, treats the final
frame as authoritative, and flushes any suffix held by the streaming redactor.
Interruption yields `STREAM_INCOMPLETE` with the conversation id; it never
re-POSTs.

### Durable runs

`GET /api/workflows/runs/:id/stream` is a snapshot stream. `watchRun` reconnects
with bounded exponential backoff, sends `last-event-id` only when it has an id,
and treats duplicate snapshots as idempotent. `EventSequencer` buffers
out-of-order frames and reports gaps. Terminal statuses stop monitoring;
`paused` and `waiting_approval` remain observable.

## Ordering rules

`preflight` runs before config resolution so an unknown command reports a usage
error, not a missing base URL. Usage errors exit `2`; contract failures exit
`7`; unavailable capabilities exit `6`. A failed run exits `1`. A local detach
exits `130` without cancelling.

## Failure semantics

| Condition | Code | Exit |
| --- | --- | --- |
| unknown command or flag misuse | `USAGE` / `UsageError` | 2 |
| insecure URL, bad timeout | `BASE_URL_*`, `TIMEOUT_INVALID` | 2 |
| no deployment or token | `BASE_URL_REQUIRED`, `UNAUTHENTICATED` | 1 / 3 |
| HTTP 401/403 or non-owner | `UNAUTHENTICATED`, `FORBIDDEN` | 3 |
| timeout or transport failure | `REQUEST_TIMEOUT`, `NETWORK` | 4 |
| HTTP 404 | `NOT_FOUND`, `HTTP_404` | 5 |
| Other HTTP errors or missing OpenAPI document/operation | `HTTP_<status>`, `OPENAPI_NOT_FOUND`, `OPERATION_NOT_FOUND` | 1 |
| missing capability or bad API major | `CAPABILITY_UNAVAILABLE`, `API_VERSION_*` | 6 |
| SSE/JSON mismatch, incomplete stream | `CONTRACT_VIOLATION`, `STREAM_INCOMPLETE` | 7 |
| local cancellation/detach | `CANCELLED` | 130 |

## Terminal memory bounds

The renderer keeps only the last response block (200 rows / 64 KiB) for resize
reflow; earlier output belongs to the terminal's scrollback. Markdown rendering
is capped at 2 MiB with an explicit truncation notice, code blocks at 4000
lines, tool activity at 200 events, conversations at 50 records, prompt history
at its configured limit, and the editor at 100 000 characters / 200 lines.

## Deliberate constraints

- No local execution, inference, database, Docker or agent process.
- No automatic POST retries for Chat; no hidden write probes during negotiation.
- No redirects; no cookie jar; no telemetry.
- No token in output, diagnostics, sessions or error text.
- Unknown backend capabilities fail closed rather than guessing paths.
