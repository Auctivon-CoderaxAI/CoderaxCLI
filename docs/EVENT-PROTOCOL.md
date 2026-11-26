# Task synchronization event protocol

Status: **coordination note for the CLI**, not a competing event contract.

The authoritative implementation is `Auctivon-CoderaxAI/Coderax` at `a5d237b0`,
in the WorkflowEngine and in the Express routes that expose it. If this document
and those files disagree, the backend wins and this document is wrong.

Files read to produce this note:

| Concern | Authoritative file |
| --- | --- |
| run record, events, store, engine deps | `packages/api/src/workflows/types.ts` |
| durable runner, retries, lease fencing | `packages/api/src/workflows/engine.ts` |
| run view, stream, approve/pause/resume/cancel | `packages/api/src/workflows/handlers.ts` |
| settlement hook, turn abort fencing | `packages/api/src/workflows/host.ts` |
| run routes | `api/server/routes/workflows.js` |
| run statuses and event types | `packages/data-provider/src/workflows.ts` |
| Work task routes | `packages/api/src/work/router.ts` |
| Work chat SSE | `api/server/routes/workChat.js` |
| generation retry/idempotency | `packages/api/src/middleware/generationRetry.ts` |

## What the backend actually guarantees

| Concern | Authoritative behaviour | Client rule |
| --- | --- | --- |
| **Task identifier** | A durable workflow task is a run: `run.id`. A Work task is a conversation: `conversationId`. | Never use one in place of the other. `cancel` selects a run by default; `--task` selects a Work conversation. |
| **Execution generation** | A generation is identified server-side by `conversationId` plus `generationCreatedAt`; cancellation is fenced with `expectedCreatedAt`. The run view does not publish a generation id. | Do not send or store a generation id. Cancellation fencing stays server-side. |
| **Event identifier** | The durable log is `{ at, type, stepId?, message? }`. There is no event id. | Do not require an id, do not hash one into a fake id, and do not present the log as replayable. |
| **Sequence number** | None. `events` is an ordered array capped at `WORKFLOW_EVENTS_MAX` (200). | Do not use `events.length` as a cursor. A capped array can shrink legitimately. |
| **Replay cursor** | The run stream is a poll of `getWorkflowRun()`: full `{run}` snapshots, identical snapshots suppressed server-side. Resuming means re-reading state. | Persist the applied **snapshot fingerprint**. Reconnect re-reads; application is idempotent. |
| **Last-Event-ID** | `/api/workflows/runs/:runId/stream` ignores it. | Send it only when a deployment actually issued `id:` values. Report `CURSOR_UNSUPPORTED` for snapshot-only streams and `CURSOR_IGNORED` when a replay proves the header had no effect. |
| **Terminal events** | Terminal statuses are `completed`, `failed`, `cancelled`; the stream closes after writing one. | Treat status, not the socket close, as terminal. Confirm with `GET /api/workflows/runs/:id` before emitting a completion notification. |
| **Permission requests** | There is no permission-request id. Approval is `POST /api/workflows/runs/:id/approve` with `{ stepIndex }`; a non-pending step answers `409`. | Address approvals by step index only. A `409` is reconciled by one authoritative read, never by a retry loop. |
| **Cancellation** | `POST /api/workflows/runs/:id/cancel` answers `200` with the existing run when the run is already terminal. Work task cancel answers `202 {canceled:true}`, or `409 WORK_TASK_ALREADY_FINISHED` / `409 WORK_NOTHING_TO_CANCEL`. | Repeated cancellation is safe and idempotent. Detach (local abort) is not cancellation. |
| **Retry** | There is no backend retry route. `retry` starts a fresh run via `POST /api/workflows/:id/runs`. | Only an explicit user action may start a new run. Never retry an ambiguous submission automatically. |
| **Notification acknowledgement** | There is no client-facing settlement-ack route. `onRunSettled` is a server hook (workflow chaining). | Confirm terminal state with an authoritative read, then de-duplicate locally per `(runId, status, settledAt)`. This is delivery de-duplication, not proof of backend delivery. |
| **Idempotency keys** | `clientRequestId` is read only by the generation-start retry middleware. `POST /api/workflows/builds` and `POST /api/workflows/:id/runs` accept no idempotency field and create a run per accepted request. | Never send an invented idempotency key to those routes. Record a local correlation key before the request, and surface an ambiguous outcome as `SUBMISSION_UNKNOWN` without retrying. |

## Client layers

| Module | Responsibility |
| --- | --- |
| `packages/workflow-sdk/src/task-events.js` | one run validator; snapshot fingerprint; strict cursor extraction (frame `id` or server `seq`/`sequence` only); terminal outcome; derived approval descriptor; legacy chat classifier/adapter |
| `packages/workflow-sdk/src/task-state.js` | applied fingerprint, authoritative cursor, terminal latch, submission intents, approval results, settlement ledger; commit-after-handle |
| `packages/workflow-sdk/src/task-client.js` | submit-once, follow with commit-after-render, approval/cancel reconciliation, authoritative settlement confirmation, outcome classification |
| `packages/workflow-sdk/src/client.js` | transport, negotiation, direct SDK calls; `watchRun` commits a frame only after its handler resolved |
| `src/task-store.js` | atomic `0600` per-deployment state file |
| `src/workflow-commands.js` | CLI presentation and exit semantics |

### Legacy adapter

`/api/work/chat` (the Work chat route) remains a compatibility surface: it
streams cumulative text snapshots with a `final` frame and no event ids.
`LegacyChatAdapter` / `classifyChatPayload` own those rules and are marked
`legacy-chat-sse`. The durable workflow run protocol is the authoritative task
protocol; the legacy adapter must not be used to claim replay support.

## Reliability rules encoded in the tests

- A snapshot is rendered first and committed second. A failed render leaves the
  cursor and fingerprint untouched, so the same snapshot is delivered again.
- A cursor is persisted only when the deployment supplied one; a snapshot-only
  stream persists `cursor: null`.
- A terminal run is latched against late non-terminal snapshots.
- Reconnects never repeat approval actions: a lost approval response is
  reconciled with a read, and a still-pending `409` is surfaced.
- An ambiguous build submission is one POST, one preserved local key, and a
  `SUBMISSION_UNKNOWN` outcome.
- Detach, disconnect, cancellation and execution failure are distinct outcomes.
- Completion notifications are emitted only after an authoritative terminal
  read, and at most once per settlement identity.

## Merge order

1. **PR #4** (`ci/fix-work-sse-fixtures`) — fixture-only, restores the green
   baseline on `main`.
2. **PR #5** (`feat/owner-cloud-client-contract`) — shared SDK and workflow
   commands. This branch is stacked on it.
3. **This branch** (`feat/task-synchronization`) — task event/state/client
   layer; no edits to `src/cli.js` or `src/product-commands.js`.
4. **Release packaging** (`freebuff/980c7f6b8ac3ccddc4c4d54c`, `171bf96`) —
   rebase after 1–3; it owns `src/cli.js` and `src/product-commands.js`.
5. **Interactive terminal** — rebase on 2–3 and render chat through
   `classifyChatPayload` so cumulative-snapshot rules stay in one place.

Conflicts are expected only in `docs/CONTRACT.md` and `ARCHITECTURE.md`; the
feature code is isolated to new files plus the SDK modules named above.
