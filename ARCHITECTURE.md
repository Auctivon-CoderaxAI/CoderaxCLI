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

engine ──► command-registry ──► engine-client ──► /v1/health + /v1/agents
           (one engine table)    (contract gate)          │
                                                            ▼
                                                    engine-commands
                                                    (thin adapter)
                                                            │
                                                            ▼
                                                    engine-surface
                                                    (adopted handlers)
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
| `src/session.js` | per-deployment conversation continuity, bounded and normalized | none |
| `src/render.js` | human tables and run rendering | none |
| `src/approval.js` | fail-closed approval policies | SDK |
| `src/discover.js` | OpenAPI discovery for legacy `openapi`/`agents`/`models` | HTTP client |
| `src/command-registry.js` | single command registry: top-level command table and handler keys, flags, WorkflowEngine 1.0.0 operations, blocked reasons, help renderer, completion generator | contract |
| `src/contract.js` | pinned engine version, route catalogue, event types and OpenAPI provenance (engine workstream) | none |
| `src/engine.js` | validated engine HTTP/SSE client with redirect refusal and response checks (engine workstream) | contract, sse |
| `src/sse.js` | engine SSE framing and JSON frame parsing (engine workstream) | none |
| `src/events.js` | event assembly, dedupe, terminal detection, reconnect policy (engine workstream) | contract |
| `src/engine-client.js` | contract-version gate, owner proof and error/exit mapping over `engine.js` | contract, engine, registry |
| `src/engine-commands.js` | thin `engine` adapter: validation, preflight, secure auth, capability matrix, fail-closed dispatch | registry, engine-client, engine-surface |
| `src/engine-surface.js` | adopted Chat, Work, task, permission, conversation, memory and artifact-metadata handlers (engine workstream) | engine, events, contract |
| `packages/workflow-sdk/src/contract.js` | routes, capabilities, statuses, documented backend gaps | none |
| `packages/workflow-sdk/src/http.js` | transport, SSE content-type enforcement, version header, idle timeout, cancellation | `fetch` |
| `packages/workflow-sdk/src/sse.js` | SSE decoder, event sequencing, deduplication, gap handling | none |
| `packages/workflow-sdk/src/client.js` | owner check, negotiation, chat, runs, builds, approvals, cancellation | contract, http, sse |
| `packages/workflow-sdk/src/redact.js` | streaming and recursive token redaction | none |

The SDK is imported by relative path. There is no workspace install step, no
npm dependency and no duplicate backend implementation inside the CLI.

## Authoritative WorkflowEngine

`coderax engine ...` targets the separate WorkflowEngine backend. The engine
does not serve an OpenAPI document, so the CLI binds to the pinned route table
in `src/contract.js` and checks the vendored document's SHA-256. The HTTP, SSE,
event-assembly and handler surface is adopted from the engine thin-client
workstream; the command registry remains the only engine command table. Every
authenticated command validates `GET /v1/health`'s `contractVersion` (1.0.x)
first, then proves the owner token with `GET /v1/agents`, and only then calls
the requested operation. Any other contract line exits `6`; a 401/403 exits
`3`. Redirects are refused by the shared transport, identifiers are validated
and URL-encoded, and no side-effecting request is retried.

Commands absent from 1.0.0 are `blocked` in the registry and return exit `6`
before configuration or HTTP. Artifact metadata is available from `getTask`;
file transfer is blocked separately. `engine capabilities --json` reports the
same matrix. Shell completion is generated from the registry by
`coderax completion <bash|zsh|fish>`, so engine completion cannot drift from
engine dispatch. Top-level dispatch and `--help` read that same registry: every
command names a handler key in the one dispatch map, and
`test/command-registry.test.js` fails if a command has no handler, a handler is
unreachable, or help/completion omits a dispatchable command. PR #6's command
behaviour is preserved without a second switch or usage list.

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
