# CLI ↔ deployment contract

Version: CLI `0.1.0`, API major `1`. Shapes were read from
`Auctivon-CoderaxAI/Coderax` at `main` (`a5d237b0`). The client-side checks live
in `test/contract.test.js`; backend gaps are tracked in
[`BACKEND-DEFECTS.md`](../BACKEND-DEFECTS.md).

## Authentication and ownership

Every request carries `Authorization: Bearer <token>`. The CLI never forwards
cookies and adds no headers except `accept`, `authorization`,
`content-type` on bodies, `last-event-id` on reconnects, and
`x-coderax-api-version: 1`.

`login` calls `GET /api/user` and accepts the token only when the returned
`role` is exactly `ADMIN` (`SystemRoles.ADMIN`). Nothing is persisted
otherwise. `whoami` repeats the check; owner-only mutations (`work submit`,
`cancel`, `resume`, `retry`, `approve`) call `requireOwner()` again so a token
that lost the role cannot mutate.

| Condition | Code | Exit |
| --- | --- | --- |
| no token | `UNAUTHENTICATED` | 3 |
| HTTP 401/403 | `UNAUTHENTICATED` / `FORBIDDEN` | 3 |
| role is not `ADMIN` | `FORBIDDEN` | 3 |
| `/api/user` missing | `OWNER_UNVERIFIABLE` | 6 |

## API version and capabilities

The deployment publishes no metadata endpoint. The client therefore sends
`x-coderax-api-version: 1`, accepts a server response header when present, and
otherwise records `API_VERSION_UNVERIFIED`. A different major is
`API_VERSION_UNSUPPORTED` (exit `6`). `--strict` turns either warning into a
failure before the operation.

Capabilities are declared in metadata when available; otherwise two safe GET
probes (`/api/work/tasks`, `/api/workflows`) fill the gaps. An undeclared
capability is never replaced by a guessed route. The CLI reports
`CAPABILITY_INFERRED`, `CAPABILITY_DEGRADED` (503), or
`CAPABILITY_UNAVAILABLE` (exit `6`).

## Routes

| Operation | Route | Shape |
| --- | --- | --- |
| identity | `GET /api/user` | `{ email, role, ... }` |
| chat / Work | `POST /api/work/chat` | body `{text, mode, endpoint, conversationId?, parentMessageId?, agent_id?, model?, promptPrefix?}`; SSE |
| Work models | `GET /api/work/models` | `{ models: [...] }` |
| Work agents | `GET /api/work/agents` | `{ agents: [...] }` |
| readiness | `GET /api/work/readiness` | JSON |
| Work history | `GET /api/work/tasks` | `{ tasks: [...] }` |
| Work task | `GET /api/work/tasks/:conversationId` | `{ task: {...} }` |
| cancel Work task | `POST /api/work/tasks/:conversationId/cancel` | JSON |
| workflows | `GET /api/workflows` | `{ workflows: [...] }` |
| runs per workflow | `GET /api/workflows/:id/runs` | `{ runs: [...] }` |
| start build | `POST /api/workflows/builds` | body `{request, mode, agentId, repository:{owner,name,baseRef?}, workspace}` |
| run | `GET /api/workflows/runs/:runId` | `{ run: {...} }` |
| run stream | `GET /api/workflows/runs/:runId/stream` | SSE `data: {"run": ...}` |
| approve | `POST /api/workflows/runs/:runId/approve` | body `{stepIndex}` |
| pause / resume / cancel | `POST /api/workflows/runs/:runId/{pause,resume,cancel}` | JSON |
| repository inventory | `GET /api/repos` | absent on the reference deployment |

There is **no global run list**. `coderax runs` therefore requires
`--workflow <id>`; `coderax run <runId>` works with a known id.

## Chat stream

The reference deployment emits cumulative text snapshots, not deltas. The CLI
accepts all three observed shapes:

```text
data: {"type":"text","text":"<cumulative>","index":0}
data: {"message":true,"text":"<cumulative>"}
data: {"final":true,"responseMessage":{"text":"...","messageId":"...","conversationId":"..."}}
data: [DONE]
```

The final frame is authoritative. The CLI rejects a `200 application/json`
response because the route is a streaming contract (`CONTRACT_VIOLATION`,
exit `7`). Response text is redacted before display and the token is never
logged.

Because frames have no `id:`, the CLI emits `CURSOR_UNSUPPORTED`. It never
retries the POST: a retry would create a second generation. An interrupted
stream is `STREAM_INCOMPLETE` (exit `7`) and reports the conversation id so the
turn can be followed through the durable Work API.

When a deployment does emit ids, `EventSequencer` de-duplicates replay,
buffers out-of-order frames, and reports `DUPLICATE_EVENT` /
`OUT_OF_ORDER_EVENT`.

## Run stream and reconnection

The reference deployment polls the run record and emits a full snapshot only
when it changes. It has no `id:` field and ignores `Last-Event-ID`.

The CLI therefore:

- reconnects with `last-event-id` when it has seen an id;
- re-reads a full snapshot on every reconnect (idempotent);
- reports `CURSOR_IGNORED` if the deployment replays an id already seen;
- reports `CURSOR_UNSUPPORTED` when snapshots carry no ids;
- retries only transport/5xx/`STREAM_INCOMPLETE` failures, with bounded
  exponential backoff (`--max-retries`, default 3);
- never retries `401`, `403`, `404`, `CONTRACT_VIOLATION`, `CANCELLED`, or an
  unknown run status.

A terminal run returns `0` (`completed`), `1` (`failed`), or `0`
(`cancelled`). A run left in `waiting_approval` with no interactive approval
returns `6`. A run in `paused` is still monitorable and returns `0` when the
stream ends without failure.

Ctrl-C aborts the local stream and leaves the server-side run alive. The
command prints the run id and conversation id and exits `130`.
`--cancel-on-interrupt` explicitly cancels instead. `--notify` rings the
terminal bell; `--notify-command` spawns a detached operator command with
`{id}` and `{status}` substituted.

## Approval

Approval policies are `ask` (default), `allow`, and `deny`. `ask` requires an
interactive TTY and a confirmation; non-interactive sessions fail closed
instead of approving automatically. An approval request sends the exact
`stepIndex` reported by the run.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success, including completed and paused runs |
| `1` | failed run or other operational failure |
| `2` | usage or configuration error |
| `3` | unauthenticated, forbidden, or not the owner |
| `4` | network failure or timeout |
| `5` | not found |
| `6` | capability or API version unavailable (fail closed) |
| `7` | contract violation, including an incomplete stream |
| `130` | cancelled or detached locally |

## Task synchronization

The backend remains authoritative. `docs/EVENT-PROTOCOL.md` records the exact
rules the task layer follows: run snapshots rather than event replay, no
synthetic event ids or sequence numbers, `Last-Event-ID` only when the
deployment issued one, approvals by `stepIndex`, idempotent cancellation,
manual-only retry, and no invented idempotency key for build submission. A lost
build response is reported as `SUBMISSION_UNKNOWN` and is never retried.

Completion notifications require an authoritative terminal read and are
de-duplicated per `(runId, status, settledAt)`. There is no client-facing
settlement-ack route, so the ledger is local delivery de-duplication, not proof
of backend delivery.

The current `/api/work/chat` cumulative-snapshot stream is kept as the clearly
marked `legacy-chat-sse` adapter. It is not a task replay protocol.

## Tests that pin this contract

`test/contract.test.js` stubs the deployment and asserts, among others:

- JSON `200` where SSE is required is rejected;
- a `2.0` API header is rejected;
- duplicate/out-of-order frames render once and in order;
- chat without ids reports `CURSOR_UNSUPPORTED`;
- reconnect sends `Last-Event-ID`, deduplicates replay, and reports
  `CURSOR_IGNORED`;
- a server restart with a snapshot-only stream converges;
- an interrupted chat POST is never retried;
- failed runs exit `1`, suspended runs are reported distinctly, and
  `waiting_approval` fails closed;
- expired credentials exit `3` without retrying;
- an unadvertised capability exits `6` without calling the guessed route.

`test/task-sync.test.js` and `test/task-http.test.js` pin the task
synchronization rules over a real loopback HTTP harness: commit-after-handle,
no synthetic cursor, submission ambiguity without a second POST, 409
reconciliation for approval and cancellation, settlement de-duplication across
processes, and distinct detach/disconnect/cancelled/failed outcomes.
