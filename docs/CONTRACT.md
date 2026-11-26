# CLI ↔ WorkflowEngine contract

The CLI targets WorkflowEngine HTTP contract **1.0.0**, SDK generation
`@coderax/sdk` **1.0.0**, and execution event schema **1**. The pinned document
and its provenance are in [`contracts/PROVENANCE.md`](../contracts/PROVENANCE.md).

Every operation is under `/v1`. No engine command discovers a path or guesses a
legacy `/api` route.

## Authentication

All owner operations send `Authorization: Bearer <token>`. `GET /v1/health` and
`GET /v1/ready` are public. `login` proves the token by calling the owner-only
`GET /v1/agents` before writing it to disk.

There is exactly one principal. The CLI has no signup, memberships, refresh
tokens or credential brokering.

## Operations used

| Operation | Method and path | CLI |
| --- | --- | --- |
| `getHealth` | `GET /v1/health` | `health` |
| `getReadiness` | `GET /v1/ready` | `ready`, `doctor` |
| `listAgents` | `GET /v1/agents` | `login`, `agents`, `capabilities`, `doctor` |
| `listModels` | `GET /v1/models` | `models`, `capabilities` |
| `submitChat` | `POST /v1/chat` | `chat` |
| `submitWork` | `POST /v1/work` | `work` |
| `getTask` | `GET /v1/work/{taskId}` | `task`, `artifacts`, `resume`, `retry` |
| `cancelTask` | `POST /v1/work/{taskId}/cancel` | `cancel` |
| `resumeTask` | `POST /v1/work/{taskId}/resume` | `resume` |
| `retryTask` | `POST /v1/work/{taskId}/retry` | `retry` |
| `streamTaskEvents` | `GET /v1/work/{taskId}/events?after=N` | `work`, `events` |
| `listConversations` | `GET /v1/conversations` | `conversations` |
| `getConversation` | `GET /v1/conversations/{conversationId}` | `conversation` |
| `listMemory` | `GET /v1/memory?mode=private\|cloud` | `memory` |
| `listPermissions` | `GET /v1/work/{taskId}/permissions` | `permissions` |
| `decidePermission` | `POST /v1/work/{taskId}/permissions` | `approve`, `deny` |
| `listNotifications` | `GET /v1/notifications` | `notifications`, `tasks` |

## Chat and Work

`POST /v1/chat` accepts `message`, optional `conversationId`, `agent`, `model`
and `mode`. Contract 1.0.0 returns one `ChatReply`; it is not streamed.

`POST /v1/work` accepts `objective`, optional `conversationId`, `agent`, `model`,
`mode` and `budget`, plus `requireApproval`. It returns `202` with a task id,
state, generation and events path as soon as ownership is recorded. Closing the
stream never ends the task.

The CLI parses `--model` as `<provider>/<model>` and sends the structured
`ModelRef`. It never substitutes an unavailable agent or model; the engine
refuses rather than falling back.

## Event stream

Each frame is `data: <json>\n\n`. An envelope carries:

- `eventId` — stable identity;
- `seq` — monotonic per task, starting at 1;
- `type` and `payload`;
- `v: 1`, task, agent, generation and timestamp.

Rules implemented by the CLI:

1. A repeated `eventId`, or `seq <= lastSeen`, is ignored.
2. `text.delta` appends; a repeated delta is preserved unless a snapshot already
   contains it.
3. `text.replace` is cumulative. If it extends the displayed text, only the
   suffix is emitted; otherwise it replaces the text exactly once.
4. Legacy `message: true` snapshots and top-level `delta` fields follow the same
   rule, so a snapshot and its incremental delta cannot print twice.
5. An unknown event type is ignored but advances the cursor, as the event
   contract requires.
6. `task.completed`, `task.failed`, `task.cancelled` and `task.interrupted` are
   terminal and close the follow loop.
7. A clean stream close without a terminal event is reconnected from the last
   sequence with bounded backoff.
8. `401`/`403` is fatal and never retried. A malformed frame is
   `STREAM_PROTOCOL`, not silent text.

## Errors

The engine returns a `Problem` body with a stable `code`, HTTP `status`,
optional `requestId` and `retryable`. The CLI preserves the code and maps it to
an exit status:

- `unauthorized`, `forbidden` → 3
- `not_found` → 5
- `validation_failed` → 2
- `engine_unavailable`, `not_ready` → 6
- timeout, transport, `STREAM_DISCONNECTED` → 4
- other problem codes → 1

## Contract-imposed limits

- **Task discovery:** there is no list-tasks operation. `tasks` is derived from
  durable notifications. An active task is identified by the id returned from
  `work`.
- **Transfers:** there is no upload or download operation. `artifact` in task
  status carries `path`, `bytes` and `digest` metadata only.
- **Chat streaming:** the published handler returns one JSON reply.
- **Engine restart durability:** task and conversation state are in memory in
  the current engine; leases use MongoDB. Restart survival is a deployment
  property and is not claimed by this client.

## Compatibility

Adding an optional request field or a new operation is backward compatible.
Removing or renaming a field, changing a type or changing a status code requires
a new contract version and `/vN` prefix. The CLI pins one contract version and
fails `doctor` on a mismatch.

## Provenance

The previously reported `feat/engine-thin-client` commit `d12a8b5` is not
reachable in any organization repository. This implementation was reconstructed
against the SDK and OpenAPI above. The sole cross-repository owner
(`@nnabdelshahid`) should confirm the pin before production use.
