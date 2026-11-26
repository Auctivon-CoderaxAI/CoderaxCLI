# Backend contract defects and dependencies

Status: **open**. Scope: `Auctivon-CoderaxAI/Coderax` at `main` (`a5d237b0`),
consumed by `coderax-cli` 0.1.0. Evidence below is from the deployment source
(`api/server/routes/work.js`, `api/server/routes/workflows.js`,
`packages/api/src/work/router.ts`, `packages/api/src/workflows/handlers.ts`).
This file is the client-side record for coordinating with the WorkflowEngine
owners. It is not a claim that any service was deployed or live-tested.

The CLI does not guess around these gaps. Each one produces a typed diagnostic
and, where the requested operation cannot be correct, a fail-closed exit.

## B1 — No API metadata or version endpoint *(high)*

**Observed.** No `/api/meta`, `/.well-known/coderax.json`, or `/api/version`
route exists. No response header advertises a supported API version.

**Client behaviour.** Sends `x-coderax-api-version: 1`; reports
`API_VERSION_UNVERIFIED`; `--strict` exits `6`. A response header with a
different major (for example `2.0`) is rejected with
`API_VERSION_UNSUPPORTED`.

**Required backend change.** Publish a small metadata document (or a response
header) containing `apiVersion`, `capabilities`, and the deployment's minimum
client version. The client already parses capabilities and probes safely when
metadata is absent.

**Acceptance test.** A contract test can assert the declared version without
probing, and a version bump fails closed before any write.

## B2 — Chat SSE has no event ids and no replay *(critical)*

**Observed.** `/api/work/chat` streams cumulative snapshots
(`{message:true,text}` / `{type:"text",text}` and a final
`{final:true,responseMessage}`). Frames carry no `id:` field; `Last-Event-ID`
is not accepted. An interrupted POST cannot be resumed: resending it starts a
second generation.

**Client behaviour.** Never retries the chat POST. Emits
`CURSOR_UNSUPPORTED` and, on an interrupted stream, `STREAM_INCOMPLETE` (exit
`7`) with the conversation id so the durable task can be monitored. Duplicate
and out-of-order frames are de-duplicated by id when a deployment supplies
them.

**Required backend change.** Emit monotonically increasing `id:` values; honour
`Last-Event-ID` on a resumable GET stream; expose a separate idempotent request
id for POST retries. Until then, the CLI cannot promise turn-level replay, and
must not pretend it can.

**Acceptance test.** Drop a connection after frame *n*, reconnect with
`Last-Event-ID: n`, and receive only frames after *n* without a second
generation.

## B3 — Run stream is polling snapshots, not an event log *(critical)*

**Observed.** `streamRun` (`packages/api/src/workflows/handlers.ts:770`) polls
the run record and writes `data: {"run":...}\n\n` only when the serialized
snapshot changes. It emits no `id:` and never reads `Last-Event-ID`. A server
restart loses any cursor the client held. `write()` deduplicates only the last
payload, not the event history.

**Client behaviour.** Reconnects with the last seen id when one exists,
reports `CURSOR_IGNORED` if the deployment replays seen ids, and reports
`CURSOR_UNSUPPORTED` when there are no ids. Because a run snapshot is
idempotent, reconnection is still safe; individual event replay is not.

**Required backend change.** Persist a run event log with stable sequence ids;
stream events with `id:`; honour `Last-Event-ID`; keep full snapshots as an
additional frame type, not the only frame.

**Acceptance test.** Restart the server between two events; a reconnecting
client receives the missed events exactly once and in order.

## B4 — No global run list *(high)*

**Observed.** Runs are listed only at `GET /api/workflows/:id/runs`
(`handlers.listRuns`). There is no `GET /api/workflows/runs` or owner-wide run
index.

**Client behaviour.** `coderax runs` requires `--workflow <id>`; without it the
command exits `2` with an explanation. `coderax run <runId>` still works with a
known id. A CLI-submitted build returns its run id, but a run started elsewhere
cannot be discovered from the CLI without the workflow id.

**Required backend change.** Add an owner-scoped, paginated run index with
workflow, status and time filters.

**Acceptance test.** A run started from the web is returned by the index and is
visible to `coderax runs` without a workflow id.

## B5 — No repository inventory *(medium)*

**Observed.** No `/api/repos` route is published.

**Client behaviour.** `coderax repos` fails closed with
`CAPABILITY_UNAVAILABLE` (exit `6`) and never calls an unadvertised path.
`coderax work submit --repo <owner/name>` still works because the build body
carries the repository explicitly.

**Required backend change.** Publish the connected-repository inventory, or
declare it absent in metadata so clients can present a precise dependency.

**Acceptance test.** Capability negotiation reports `repos.list` only when the
route exists, and listing never falls back to a guessed path.

## B6 — Cross-surface visibility is not verifiable here *(blocked, not a defect)*

No authorized deployment URL or owner token is available to this work, and
additional spending is capped at $0.00. `scripts/verify-cross-surface.mjs` is
read-only and fails closed (`6`) unless `CODERAX_VERIFY_BASE_URL`,
`CODERAX_VERIFY_TOKEN`, and a shared `CODERAX_VERIFY_TASK_ID` or
`CODERAX_VERIFY_RUN_ID` are supplied. It creates no Work and starts no run.

The web UI and CLI use the same owner-scoped Work and workflow APIs, so a
server-side visibility test is the correct check once an authorized
environment exists. The reverse direction (CLI-created task rendered in the
web UI) still needs a browser session; the script prints the shared id and
status for that manual confirmation.

## B7 — Owner gate depends on `/api/user` *(medium)*

**Observed.** `/api/user` exists and returns the authenticated user, but the
deployment does not advertise the owner role as a machine-readable capability.
The client requires `role === "ADMIN"` (`SystemRoles.ADMIN`).

**Client behaviour.** `login` stores nothing unless the role is exactly
`ADMIN`; a missing endpoint produces `OWNER_UNVERIFIABLE` and stores nothing.
`whoami` and every owner-only mutation re-check the role.

**Required backend change.** Keep `/api/user.role` stable, or publish the
owner identity in metadata. Document that `ADMIN` is the instance-owner role,
not a tenant-scoped role.

## Dependency summary

| CLI capability | Backend dependency | Without it |
| --- | --- | --- |
| `chat` | `/api/work/chat` SSE | fails closed; no guessed route |
| `work` | same SSE endpoint, `mode:"work"` | fails closed |
| `work submit` | `POST /api/workflows/builds` | fails closed |
| `tasks` | `/api/work/tasks[/:id]` | exit `6` if absent |
| `runs` | per-workflow `/runs`; no global index | requires `--workflow` |
| `run` / approvals | run stream + approve/pause/resume/cancel | exit `6`/`7` |
| `repos` | `/api/repos` | exit `6` |
| API version | metadata/header | `API_VERSION_UNVERIFIED`; `--strict` exit `6` |
| event replay | SSE ids + `Last-Event-ID` | `CURSOR_UNSUPPORTED`; reconnect re-reads snapshots |
