# WorkflowEngine contract

CLI `1.0.0` targets the authoritative Coderax WorkflowEngine API:

- API prefix `/v1`
- `CONTRACT_VERSION` `1.0.0`
- `EVENT_SCHEMA_VERSION` `1`
- OpenAPI 3.1 document generated from the engine's route catalogue

The canonical sources are the WorkflowEngine repository's
`packages/contracts` and its published `openapi.json`. This CLI contains a
dependency-free mirror in `src/engine/contract.js`; the reviewed OpenAPI
artifact is vendored in `contracts/workflow-engine-1.0.0.openapi.json` with its
commit and digest in `contracts/PROVENANCE.md`. CI validates the digest, the
route table and a live engine checkout at the same pinned commit.

## Authentication

Owner routes require `Authorization: Bearer <owner token>`. `/v1/health` and
`/v1/ready` are `public` in the route catalogue. The CLI never sends an
anonymous owner request, and it does not add cookies.

The owner token is sent only to the configured engine origin. Redirects are
refused. `401` triggers one token refresh attempt; if no different token is
available, the command exits `3`.

## Negotiation

`GET /v1/health` returns `contractVersion`. The CLI compares it with
`CONTRACT_VERSION` before submitting Chat or Work. An unknown mismatch exits
`7` with `CONTRACT_UNSUPPORTED` and both versions; a known newer contract
(`1.1.0`/`1.2.0`) exits `7` with `CONTRACT_ADAPTER_PENDING`. The client does not
partially use a different contract.

Execution events are negotiated independently. Every event carries
`v: 1`. An event with another `v` is a contract error. An unknown event type
with a supported `v` is skipped, so a newer engine can add event types without
breaking an older CLI.

## Routes used

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Public liveness, contract version, engines and capabilities |
| `GET` | `/v1/ready` | Public readiness |
| `GET` | `/v1/agents` | Agent identities and truthful availability |
| `GET` | `/v1/models` | Models, cost class and free route |
| `POST` | `/v1/chat` | One Chat turn, SSE when accepted |
| `POST` | `/v1/work` | Submit a durable Work task (`202`) |
| `GET` | `/v1/work/{taskId}` | Authoritative task status |
| `POST` | `/v1/work/{taskId}/cancel` | Cancel from any replica |
| `POST` | `/v1/work/{taskId}/resume` | Resume from checkpoint |
| `POST` | `/v1/work/{taskId}/retry` | Retry with a new generation |
| `GET` | `/v1/work/{taskId}/events` | Replay and tail execution events |
| `GET` | `/v1/work/{taskId}/permissions` | Pending and decided approvals |
| `POST` | `/v1/work/{taskId}/permissions` | Approve or deny one request |
| `GET` | `/v1/conversations` | Shared conversation history |
| `GET` | `/v1/conversations/{conversationId}` | Conversation with messages |
| `GET` | `/v1/memory?mode=` | Owner-scoped memory |
| `GET` | `/v1/notifications` | Durable completion notifications |

The CLI uses `eventsPath` from the submit response when supplied; otherwise it
constructs `/v1/work/{taskId}/events`, which is the contract route.

## Work submission and idempotency

`WorkSubmitRequest` is strict:

```json
{
  "objective": "string (1..200000)",
  "conversationId": "optional id",
  "agent": "coderax | opencode | freebuff",
  "model": { "providerId": "...", "modelId": "..." },
  "mode": "private | cloud",
  "budget": { "maxRequests": 1, "maxInputTokens": 1, "maxOutputTokens": 1 },
  "requireApproval": true
}
```

The engine's submit operation is not idempotent. The CLI generates an
idempotency key, persists it before sending, and sends it as `idempotency-key`
and `x-coderax-client-request-id`. The local ledger is authoritative:

- An accepted key maps to exactly one `taskId`.
- A definite 4xx rejection is recorded as failed; it is not retried
  automatically.
- A timeout, lost response, `408`, `429` or `5xx` leaves the outcome unknown and
  records `SUBMISSION_UNCERTAIN`. The CLI exits `9` and does not submit again.
- `coderax work resolve <key> <taskId>` binds the key to the task that actually
  exists. `--retry-submission` is an explicit owner decision to submit again.

The engine may ignore the advisory header; this does not weaken the at-most-once
behavior, because the CLI never sends the same key twice without explicit
confirmation.

## Task control

`POST .../cancel` accepts `{ "reason"?: string }`.
`POST .../resume` and `.../retry` require the current `generation`.
Responses are `TaskControlResult`:

```json
{ "taskId": "...", "state": "queued", "generation": 0, "outcome": "accepted" }
```

`outcome` is `accepted`, `already_terminal`, `not_found` or `superseded`. The
CLI reports the engine's outcome; it never pretends a request succeeded.

## Execution events

Envelope fields: `v`, `eventId`, `taskId`, `seq`, `at`, `agent`, `generation`,
`type`, and `payload` for types that need one.

| Type | Payload |
| --- | --- |
| `task.queued` | none |
| `task.started` | optional `{ sessionId? }` |
| `step.started`, `step.completed` | `{ stepId, title }` |
| `text.delta` | `{ text }` (non-empty) |
| `text.replace` | `{ text }` (may be empty) |
| `tool.call` | `{ callId, tool, input? }` |
| `tool.result` | `{ callId, tool, ok, output? }` |
| `file.edit` | `{ path }` |
| `approval.required` | `{ requestId, tool, description }` |
| `usage` | `{ inputTokens?, outputTokens? }` |
| `task.completed` | optional `{ summary?, model?, usage? }` |
| `task.failed` | `{ code, retryable, detail? }` |
| `task.cancelled` | `{ reason? }` |
| `task.interrupted` | `{ detail }` |

Terminal events are `task.completed`, `task.failed`, `task.cancelled` and
`task.interrupted`. Terminal task states also include `interrupted`.

## Cursors, replay and deduplication

`GET /v1/work/{taskId}/events` accepts `?after=<seq>` and honours
`Last-Event-ID`. The CLI sends both. Sequence numbers are monotonic per task
and start at 1.

- An event with `seq <= lastSeq` is ignored.
- A repeated `eventId` is ignored.
- `seq != lastSeq + 1` is a gap. The CLI does not apply the frame; it reconnects
  from `lastSeq`. More than three gaps exits `7` with `EVENT_GAP` rather than
  silently losing an event.
- A stream that closes without a terminal event re-reads task status. If the
  task is still active, it reconnects with bounded exponential backoff and
  jitter. If the status is terminal, that authoritative state is used.
- After the reconnect budget, the CLI exits with `STREAM_INTERRUPTED`, including
  the cursor, and tells the owner to attach again. The cloud task is not
  cancelled.

## Problems and exit codes

Errors use the engine's Problem document:

```json
{
  "type": "https://...",
  "title": "...",
  "status": 409,
  "code": "conflict",
  "detail": "...",
  "requestId": "...",
  "retryable": false
}
```

`code` is preserved in machine output. HTTP `401`/`403` maps to exit `3`,
`404` to `5`, `408`/network to `4`, `409`/`busy` to `10`, `429` and `5xx` are
retryable where the operation is safe, and `permission_required`/approval to
`8`. Unknown codes are reported, not invented.

## Legacy deployment surface

`coderax deploy ...`, `coderax call`, `coderax products`, `coderax cloud` and
`coderax projects` address an older OpenAPI deployment, not the WorkflowEngine
`/v1` API. They are retained for compatibility. They do not fall back to a
different engine, and they never execute a workflow locally.

## Compatibility policy

- A CLI release pins one `CONTRACT_VERSION` and one `EVENT_SCHEMA_VERSION`.
- `1.1.0` (engine PR #7) and the unpublished unified `1.2.0` contract are
  classified as adapter-pending. The CLI exits `7` with
  `CONTRACT_ADAPTER_PENDING`; it does not guess routes or simulate operations.
  See `docs/CONSOLIDATION.md`.
- Adding routes or event types is backward compatible for this client: unknown
  event types are skipped, and unused routes are ignored.
- Changing a validated field, removing a route, or changing an enum is a
  contract change and requires a CLI release.
- The pinned engine commit and its `openapi.json` are checked in CI. Update the
  pin only after reviewing the engine's contract diff and running the CLI suite.
