# Architecture

The CLI is a transport and rendering layer. The WorkflowEngine owns every
decision about models, agents, execution, permissions and persistence.

```
argv ──► parseArgv ──► preflight ──► resolveSettings ──► command
                          │              │                 │
                     usage errors   config.js         ┌─────┴──────────┐
                     (exit 2)       env + 0600 file    │                │
                                                       ▼                ▼
                                             engine-commands.js    legacy openapi /
                                                       │             call
                          ┌────────────────────────────┼───────────────┐
                          ▼                            ▼               ▼
                      engine.js                    events.js        config.js
                    HTTP + SSE client        assembler + reconnect
                          │                            │
                          ▼                            ▼
                      sse.js                     contract.js
                chunk-safe framing       pinned routes + versions
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/contract.js` | pinned contract version, route catalogue, event types, capability truth | nothing |
| `src/sse.js` | chunk-safe SSE framing, CRLF handling, JSON frames | nothing |
| `src/engine.js` | one versioned HTTP/SSE request per call, error mapping, response validation | fetch, contract |
| `src/events.js` | duplicate-safe text assembly, cursor, reconnect and terminal handling | contract |
| `src/engine-commands.js` | Chat, Work, tasks, replay, control, permissions, history, diagnostics | engine, events, config |
| `src/config.js` | resolve, validate and atomically persist connection settings | filesystem, environment |
| `src/cli.js` | parsing, preflight, dispatch, output redaction | all of the above |
| `src/client.js` | legacy single-request/SSE helper used by `call` and `openapi` | fetch only |
| `src/discover.js` | legacy OpenAPI discovery for `openapi`; no engine command guesses a route | client |

Each layer is injectable: tests pass `fetchImpl`, `env`, `stdout`, `stderr` and
file readers, so the suite runs without a deployment.

## Invariants

1. **Server authority.** Task state, conversations, permissions and
   notifications are read from the engine. The CLI never derives a terminal
   state or invents a task.
2. **No orchestration.** There is no model routing, planner, tool runner, task
   queue or database in this repository.
3. **Owner only.** There is no signup, membership or billing surface. Login is
   accepted only when an owner-only operation succeeds.
4. **One client contract.** The route table and versions come from the pinned
   engine OpenAPI document; `test/contract.test.js` fails on drift.
5. **Event durability is server-side.** Detaching closes a stream, not a task.
   Reconnecting uses `after=<lastSeq>` and replays retained events.
6. **Dedupe before display.** `eventId` and per-task `seq` are the identity of
   an event. A replayed or out-of-order event is ignored.
7. **Snapshots win over their deltas.** A cumulative snapshot that extends the
   displayed text emits only the suffix; a snapshot that rewrites it emits one
   replacement. An incremental delta already present at the end of a snapshot is
   discarded, never printed twice.
8. **Token hygiene.** Every output path passes through redaction. The token is
   never in a URL, config summary, error message or streamed event.

## Event pipeline

```
GET /v1/work/{id}/events?after=N
        │
        ▼
  SseDecoder  ── frame split at any byte, CRLF/lone CR ──► JSON envelope
        │
        ▼
  EventAssembler ── duplicate? ──► ignore
        │              │
        │              ├─ text.delta ──► append unseen
        │              ├─ text.replace ──► suffix or replacement
        │              └─ task.completed/failed/cancelled/interrupted ──► terminal
        ▼
  render / JSON output / cursor advance
```

A clean close without a terminal event is a reconnect, not a completion. A 401,
403, 404, malformed frame or contract violation is fatal. A network failure,
idle deadline or 5xx is retried with bounded backoff; the reconnect count resets
after any received event.

## Failure semantics

| Condition | Code | Exit |
| --- | --- | --- |
| unknown command, flag misuse, invalid agent/model/mode | `USAGE` | 2 |
| insecure URL, bad timeout, unreadable config | `BASE_URL_*`, `TIMEOUT_INVALID` | 2 |
| no engine configured | `BASE_URL_REQUIRED` | 1 |
| HTTP 401/403 or engine `unauthorized`/`forbidden` | `unauthorized`, `forbidden` | 3 |
| HTTP 404 or engine `not_found` | `not_found` | 5 |
| timeout, transport failure, lost stream | `REQUEST_TIMEOUT`, `REQUEST_FAILED`, `STREAM_DISCONNECTED` | 4 |
| engine unavailable or not ready | `engine_unavailable`, `not_ready` | 6 |
| contract mismatch, malformed event, other engine failure | `CONTRACT_*`, `STREAM_PROTOCOL`, engine code | 1 |
| task cancelled or client detached | `CANCELLED` | 130 |

## Deliberate constraints

- One request per command, except `capabilities` and `doctor` (parallel reads)
  and the event stream.
- No redirects: `redirect: "error"`.
- No cookie jar, telemetry or persistent HTTP agent.
- No local task database. The only local state is the owner token and defaults.
- No artifact transfer: contract 1.0.0 has no such operation.
- No inference, build, test or engineering workload runs on the client host.
