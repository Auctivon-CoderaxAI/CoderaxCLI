# WorkflowEngine surface

`coderax engine` is the durable task surface over the authoritative
**Coderax-WorkflowEngine** `/v1` API. It is separate from the legacy Coderax
`/api/*` adapter described in [`COMPATIBILITY.md`](COMPATIBILITY.md) and does
not share task state with it.

## Pinned contract

| Item | Value |
| --- | --- |
| Contract | `1.2.0`, major `1`, supported `1.0.0`/`1.1.0`/`1.2.0` |
| Fingerprint | `sha256:dd90179e40429ed4e91b75e0e3606be668c8fd1a7cf068d1f2c4f329b4516f21` |
| Execution events | schema `1` (`eventId`, per-task `seq`, `stream.truncated`) |
| Chat frames | schema `1` |
| SDK | `@coderax/sdk` `1.2.0`, 40,144 bytes, SHA-256 `223ce865…187a8c` |
| Source | WorkflowEngine PR #7, commit `a048a0283e6aa32531f7a6c1b74034843230ab0f` |
| Document | [`contracts/workflow-engine-1.2.0.openapi.json`](../contracts/workflow-engine-1.2.0.openapi.json), SHA-256 `7d73c5cd…b0efa1` |

The engine repository's `main` at inspection time published `1.0.0`; PR #7 is
the authoritative 1.2.0 contracts/SDK branch. See
[`contracts/PROVENANCE.md`](../contracts/PROVENANCE.md) for the pin rationale
and [`MERGE-PLAN.md`](MERGE-PLAN.md) for the upstream dependency order.

`npm run verify:engine -- --engine ../Coderax-WorkflowEngine` checks the
vendored document, the route table, the fingerprint, the SDK version and the
SDK tarball digest against a real checkout. It fails on any drift.

## Commands

| Command | Operation |
| --- | --- |
| `coderax engine status` | handshake, compatibility report, capabilities and limits |
| `coderax engine handshake` | raw `GET /v1/handshake` document |
| `coderax engine submit "<objective>" [--agent] [--mode] [--model] [--idempotency-key] [--detach]` | `POST /v1/work` |
| `coderax engine tasks [--state] [--limit]` | `GET /v1/tasks` (the `GET /v1/work` alias is also covered) |
| `coderax engine task <taskId>` | `GET /v1/work/{taskId}` and snapshot reconciliation |
| `coderax engine events <taskId> [--after <seq>]` | replay and tail `GET /v1/work/{taskId}/events` |
| `coderax engine cancel <taskId> [--reason]` | `POST /v1/work/{taskId}/cancel` |
| `coderax engine resume <taskId> [--generation]` | `POST /v1/work/{taskId}/resume` |
| `coderax engine retry <taskId> [--generation]` | `POST /v1/work/{taskId}/retry` |
| `coderax engine permissions <taskId>` | `GET /v1/work/{taskId}/permissions` |
| `coderax engine approve\|deny <taskId> <requestId>` | `POST /v1/work/{taskId}/permissions` |
| `coderax engine notifications` | `GET /v1/notifications` |
| `coderax engine ack <taskId>` | `POST /v1/notifications/{taskId}` |
| `coderax engine reconcile <taskId>` | authoritative snapshot read |

The client covers every operation in the 1.2.0 catalogue (artifacts, memory,
conversations, schedules, chat) so the contract cannot drift behind the CLI; the
commands above are the durable task control surface.

## Durable synchronization rules

1. **Task discovery** uses the engine read model (`/v1/tasks`, `/v1/work`), never
   a local cache. A task submitted by Coderax Web is visible to the CLI and vice
   versa because both read the same engine.
2. **Persistent identifiers** are the engine's `taskId`, `conversationId`,
   `eventId` and per-task `seq`. The CLI never synthesises an event ordinal.
3. **Event ordering:** `seq` is monotonic per task starting at 1. `seq <= cursor`
   and repeated `eventId`s are dropped. A gap triggers snapshot reconciliation
   before the next event is applied, and is reported as `REPLAY_GAP`.
4. **Duplicate prevention:** applied event ids (bounded) and the persisted cursor
   are committed only after the renderer/handler resolves. A failed handler
   leaves the cursor unchanged, so the event is re-delivered.
5. **Cursor persistence:** the cursor is `seq`, sent as `?after=<seq>`; the
   client does not rely on `Last-Event-ID`.
6. **Snapshot reconciliation:** `stream.truncated` ({after, oldestSeq}) means
   the replay window is gone. The CLI reconciles `GET /v1/work/{taskId}`,
   records the receipt if terminal, and resumes at `oldestSeq - 1`.
7. **Streaming reconnection:** a dropped or idle stream reconnects from the last
   applied sequence with bounded exponential backoff. `401`/`403`/`404` and
   contract violations are fatal and never retried.
8. **Detachment:** Ctrl-C closes only this stream (`detached: true`). The engine
   owns the task; reattach with `engine events <taskId>`.
9. **Cancellation, pause and resume:** cancel is safe after disconnect. Contract
   1.2.0 publishes `resume` and `retry` but **no pause operation**; the CLI does
   not invent one. `resume`/`retry` send the recorded fencing `generation`; a
   `superseded` or `not_found` outcome is reported and reconciled, never retried
   in a loop.
10. **Permission requests:** listed from the engine, decided by `requestId` with
    `approved`/`denied`; a decision is recorded locally to avoid duplicate
    prompts, but the engine remains authoritative.
11. **Completion receipts:** a terminal event is confirmed with an authoritative
    `GET /v1/work/{taskId}` before a receipt is recorded. If confirmation is
    unavailable, the result says `receipt unconfirmed` rather than claiming it.
12. **Notification acknowledgements:** `POST /v1/notifications/{taskId}`;
    repeated acknowledgement is idempotent and reports the engine's unread count.
13. **Cross-device continuity:** state is advisory and per owner/environment; a
    second device replays events from zero and reconciles the same task. Closing
    either client never terminates an authorized engine task.

## Idempotency and recovery

`POST /v1/work` accepts a caller-chosen `idempotencyKey` (8–120 url-safe
characters). The CLI generates `cli-<uuid>` unless `--idempotency-key` is given
and persists the intent **before** the request leaves.

- A definitive rejection marks the submission `failed`.
- A network error, timeout or 5xx marks it `unknown`. It is **never retried
  automatically**; a second submit of the same objective is refused and names
  the key.
- `--resume-key <key>` reuses the same server reservation. The objective must
  match the recorded SHA-256, so the key cannot silently submit different work.
  The engine answers `replayed: true` with the original task instead of creating
  a second run.
- A successful response with `replayed: true` is reported as a replay.

This trades an automatic retry (which could duplicate repository operations or
tool calls) for an explicit, auditable reconciliation.

## Local state and privacy

Files live beside the CLI config as `engine-<partition>.json`, mode `0600`
inside a `0700` directory. Symbolic links are refused.

The partition is:

```
sha256(origin \n sha256(owner token)[0:16] \n environment)
```

`environment` is `CODERAX_ENVIRONMENT`/`--environment`, otherwise `local` for a
loopback origin and `production` otherwise. A state file loaded under another
partition is refused (`STATE_PARTITION_MISMATCH`). The owner token itself is
never written; the stored value is a truncated one-way digest used only to
separate principals.

Stored: cursors, bounded applied event ids, task state/generation/updatedAt,
submission objective digests, permission decisions and notification
acknowledgements.

Never stored: prompts/objectives, transcripts, tool output, artifact content,
permission descriptions, headers or credentials. Local state is never treated as
authoritative task status.

## Legacy adapter

`packages/workflow-sdk` is retained as `coderax-legacy-api-adapter` for
deployments that still expose only `/api/*`. It is a temporary compatibility
path, not a second authority: no new capability is added there, and the canonical
client is `src/engine-client.js` on the 1.2.0 contract. Its old task layer had no
event ids, sequence numbers or server idempotency, which is exactly why the
authoritative surface is `/v1`.

## Acceptance evidence

`node scripts/run-engine-acceptance.mjs --engine <checkout>` starts the engine's
own `startTestApp()` HTTP application at the pinned commit (real router, service,
auth and SSE; deterministic model gateway) and runs
`test/engine-acceptance.test.js` against it:

```
✔ the engine publishes the pinned 1.2.0 contract
✔ submit is idempotent, events replay durably and a second client sees the same task
✔ notifications are durable and acknowledgement is idempotent
ℹ tests 3  ℹ pass 3  ℹ fail 0
```

It does not mirror legacy Coderax handlers. It requires a built engine checkout
(`npm ci && npm run build`); it needs no database, credential or deployment.
The `engine-acceptance` job in `.github/workflows/ci.yml` performs the same run
on a GitHub-hosted ubuntu runner, checking out the pinned engine commit and
building it before the suite. It uses no secret and no paid runner, and the
required `test` gate includes it.

## Remaining limitations

- The engine repository has **no deployment**. Acceptance runs against its real
  in-process application on loopback, not a production origin.
- PR #7 is unmerged and must land before a released CLI can depend on 1.2.0;
  `main` still serves 1.0.0 without the handshake, idempotency or task list.
- The engine is a `private` TypeScript workspace with a `zod` runtime. The CLI
  ships dependency-free, so it consumes the pinned contract with
  `src/engine-client.js`; it does not import the tarball at runtime.
- No pause operation exists in 1.2.0. OS keychain storage is still not
  implemented (see `COMPATIBILITY.md`).
