# CLI ↔ WorkflowEngine contract

The CLI consumes contract **1.1.0** through the canonical `@coderax/sdk` 1.1.0
package published by WorkflowEngine pull request #7
(`9b4cb5ce4f8688cf232d006028e5e255eda6cb1f`). It does not invent a route, a
payload or a capability registry. Every path below is a published operation in
that engine's route catalogue (`packages/contracts/src/routes.ts`).

> `contract/authoritative-v1.1` (`ea66028`) publishes a different 1.1.0 SDK and
> a different artifact surface. It is a competing implementation, not the
> artifact this client consumes. See `vendor/PROVENANCE.md`.

## Negotiation

`GET /v1/handshake?contract=1.1.0` is fetched once per invocation, before any
capability runs. It is an **owner** operation. The SDK validates the document
against `CapabilityHandshake`; `checkCompatibility` then checks:

- `contractMajor` equals this SDK's major;
- `supportedContractVersions` contains `1.1.0`;
- `eventSchemaVersion` matches the SDK's event schema;
- `chatStreamVersion` matches the SDK's chat stream version;
- every operation this client requires is published.

Any mismatch is `CONTRACT_INCOMPATIBLE` (exit `7`) and no capability request is
sent. `handshake.operations` is the authoritative operation set: a family whose
required operation is absent is `unverified`, never executed. A published
operation with no method on the canonical SDK is also `unverified`, because the
client cannot call it.

`handshake.capabilities` is a flat object of booleans derived by the engine from
its own route table. The CLI never upgrades a `false` or absent flag.

## Owner authentication

Every operation except `getHealth` and `getReadiness` requires
`Authorization: Bearer <token>`. Owner authorization is enforced by the engine:
a 401/403 becomes `UNAUTHENTICATED` (exit `3`). `readiness` performs one
owner-only read (`GET /v1/agents`) so an operator can prove the token is
accepted before submitting work.

## Operations used

| Operation | Method and path | Used for |
| --- | --- | --- |
| `getHealth` | `GET /v1/health` | readiness output |
| `getReadiness` | `GET /v1/ready` | readiness output |
| `getHandshake` | `GET /v1/handshake` | capability resolution, compatibility |
| `listAgents` | `GET /v1/agents` | owner proof, agent discovery |
| `listModels` | `GET /v1/models` | model discovery |
| `submitWork` | `POST /v1/work` | every capability request |
| `listTasks` | `GET /v1/work` | owner task read model |
| `getTask` | `GET /v1/work/{taskId}` | authoritative state, result, failure |
| `streamTaskEvents` | `GET /v1/work/{taskId}/events?after=N` | progress and replay |
| `cancelTask` | `POST /v1/work/{taskId}/cancel` | explicit cancellation and upload cleanup |
| `listArtifacts` | `GET /v1/work/{taskId}/artifacts` | result listing |
| `createArtifact` | `POST /v1/work/{taskId}/artifacts` | validated attachment storage |
| `getArtifact` | `GET /v1/work/{taskId}/artifacts/{artifactId}` | metadata and bytes in one read |
| `listSchedules` | `GET /v1/schedules` | `schedules list` |
| `createSchedule` | `POST /v1/schedules` | `schedules create` |
| `controlSchedule` | `POST /v1/schedules/{scheduleId}` | `schedules pause/resume` |
| `deleteSchedule` | `DELETE /v1/schedules/{scheduleId}` | `schedules delete` |
| `listPermissions` | `GET /v1/work/{taskId}/permissions` | `permissions list` |
| `decidePermission` | `POST /v1/work/{taskId}/permissions` | `permissions approve/deny` |

Routes that do **not** exist in this contract and are therefore not used:
`GET /v1/capabilities`, `POST /v1/capabilities/{id}/execute`, `POST /v1/files`,
`GET /v1/artifacts/{id}`, `GET /v1/artifacts/{id}/content`,
`POST /v1/artifacts/{id}/project`, `GET /v1/permissions`,
`GET /v1/schedules/{id}`, `POST /v1/schedules/{id}/cancel`,
`GET /v1/schedules/{id}/runs`, and every `/v1/media/*`, `/v1/creative/*` and
`/v1/games/*` route. Contract 1.1.0 publishes no execution-history route;
`schedules list` reports the per-schedule `runs`, `skipped`, `lastRunAt` and
`lastTaskId` the engine records.

## Work submission

`POST /v1/work` accepts a strict `WorkSubmitRequest`:

```json
{
  "objective": "Create a markdown document ...",
  "mode": "cloud",
  "requireApproval": true,
  "idempotencyKey": "cli:1730000000000:<uuid>",
  "agent": "coderax",
  "model": { "providerId": "local", "modelId": "zero" },
  "conversationId": "conv-..."
}
```

- `objective` is the capability request; the engine's agent decides how to
  satisfy it. The CLI never plans or executes steps.
- `agent` is sent only when the operator supplies `--agent` and must be one of
  `coderax`, `opencode`, `freebuff`.
- `model` is sent only for `--model <providerId>/<modelId>`.
- `idempotencyKey` is generated per invocation so an ambiguous network failure
  can be reconciled with the owner-scoped task instead of silently duplicated.
  The CLI does not retry a submission.
- A `202 TaskAccepted` returns `taskId` and `eventsPath`.

## Attachments

The contract transfers artifact bytes as base64 inside JSON, scoped to a task:

```json
{ "path": "report.pdf", "mediaType": "application/pdf", "encoding": "base64", "content": "..." }
```

- `path` must be relative, at most 1024 characters, with no `..` segment and no
  drive letter. The CLI reduces a local name to a safe basename.
- `content` is at most 700,000 characters. The CLI refuses local files above
  512 KiB before reading them, which encodes to 699,052 characters and fits both
  the field bound and the engine's 1 MiB request body.
- The engine computes and returns the record's `bytes` and `digest`
  (`sha256:<64 hex>`); a caller may not state them. The CLI requires both to
  equal the local byte count and SHA-256; otherwise it cancels the task and
  reports `ARTIFACT_INTEGRITY_FAILED`.

Because `WorkSubmitRequest` has no attachment field, the order is: submit, then
upload to the accepted task. If the upload fails the task is cancelled, so no
run observes a missing input.

`GET /v1/work/{taskId}/artifacts/{artifactId}` returns
`{ artifact, encoding, content }`. The record is verified against the list
entry and the task id before any bytes are used.

## Downloads

- The descriptor must match the metadata record and the requested task;
  otherwise the download is refused before writing.
- `encoding` is `base64` or `utf8`. The decoded bytes are hashed and compared
  with the published digest and byte count. A mismatch deletes the temporary
  file and leaves the destination untouched.
- The destination is resolved locally: `--out`, or the artifact basename in the
  current directory. `--force` is the only authorization to replace an existing
  file. Directories, missing parents and symlinks are refused.

## Progress

`streamTaskEvents` yields versioned `ExecutionEvent` frames through
`CoderaxClient.events()`. The SDK owns framing and schema validation. The CLI:

- applies events in sequence order and ignores an already-applied sequence or
  event id;
- resumes with `after=<lastSeq>` after a drop;
- surfaces `stream.truncated` (`payload.after`, `payload.oldestSeq`) as a
  warning that earlier events are no longer retained;
- polls `getTask` when the deployment does not publish the stream; that is a
  degradation, not a failure.

Terminal task states are `completed`, `failed`, `cancelled`, `interrupted`.
`awaiting_approval` is not terminal: the CLI reports the request id and keeps
waiting until the owner decides or the local deadline expires.

## Errors

Problems map to stable CLI codes at the boundary:

| Problem / transport | CLI code | Exit |
| --- | --- | --- |
| 401/403 | `UNAUTHENTICATED` | 3 |
| 404 | `NOT_FOUND` | 5 |
| 400/422 | `REQUEST_REJECTED` | 1 |
| 409 | `CONFLICT` | 1 |
| 429 | `RATE_LIMITED` | 4 |
| 503 | `UNAVAILABLE` | 6 |
| 5xx | `SERVER_ERROR` | 4 |
| incompatible handshake | `CONTRACT_INCOMPATIBLE` | 7 |
| schema violation | `CONTRACT_VIOLATION` | 7 |
| local deadline | `WAIT_TIMEOUT` | 4 |
| abort signal | `CANCELLED` | 130 |

## Compatibility

The engine may add optional fields on the same major; the SDK parses them and
the CLI ignores what it does not use. A removed operation, a changed required
field or a different major is refused before execution. There is no downgrade
mode and no local fallback.
