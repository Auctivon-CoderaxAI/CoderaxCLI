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
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/cli.js` | parsing, preflight, dispatch, exit-code mapping, top-level errors | every command module |
| `src/config.js` | resolve, validate, atomically persist settings; 0600/0700; symlink refusal; sessions; role | filesystem, environment |
| `src/product-commands.js` | owner login/logout/whoami/status, doctor, legacy discovery commands | SDK, config, discovery |
| `src/workflow-commands.js` | chat, Work, autonomous submit, tasks, runs, approvals, cancel/resume/retry, notifications | SDK, session, render, approval |
| `src/session.js` | per-deployment conversation continuity, bounded and normalized | none |
| `src/render.js` | human tables and run rendering | none |
| `src/approval.js` | fail-closed approval policies | SDK |
| `src/discover.js` | OpenAPI discovery for `openapi`/`agents`/`models` | HTTP client |
| `packages/workflow-sdk/src/contract.js` | routes, capabilities, statuses, documented backend gaps | none |
| `packages/workflow-sdk/src/http.js` | transport, SSE content-type enforcement, version header, idle timeout, cancellation | `fetch` |
| `packages/workflow-sdk/src/sse.js` | SSE decoder, event sequencing, deduplication, gap handling | none |
| `packages/workflow-sdk/src/client.js` | owner check, negotiation, chat, runs, builds, approvals, cancellation | contract, http, sse, task-events |
| `packages/workflow-sdk/src/task-events.js` | authoritative run validation, snapshot identity, cursor extraction, approval descriptor, legacy chat adapter | contract |
| `packages/workflow-sdk/src/task-state.js` | applied snapshot/cursor, terminal latch, submission intents, settlement ledger | task-events |
| `packages/workflow-sdk/src/task-client.js` | submit-once, follow, approval/cancel reconciliation, settlement confirmation | client, task-events, task-state |
| `src/task-store.js` | atomic 0600 per-deployment task state | filesystem |
| `packages/workflow-sdk/src/redact.js` | streaming and recursive token redaction | none |

The SDK is imported by relative path. There is no workspace install step, no
npm dependency and no duplicate backend implementation inside the CLI.

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
| HTTP 404 | `NOT_FOUND` | 5 |
| missing capability or bad API major | `CAPABILITY_UNAVAILABLE`, `API_VERSION_*` | 6 |
| SSE/JSON mismatch, incomplete stream | `CONTRACT_VIOLATION`, `STREAM_INCOMPLETE` | 7 |
| local cancellation/detach | `CANCELLED` | 130 |

## Deliberate constraints

- No local execution, inference, database, Docker or agent process.
- No automatic POST retries for Chat; no hidden write probes during negotiation.
- No redirects; no cookie jar; no telemetry.
- No token in output, diagnostics, sessions or error text.
- Unknown backend capabilities fail closed rather than guessing paths.
