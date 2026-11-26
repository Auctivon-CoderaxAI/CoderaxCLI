# CLI ↔ WorkflowEngine contract

The CLI consumes contract **1.1.0** through the canonical `@coderax/sdk` 1.1.0
package. It does not invent a route, a payload or a capability registry. Every
path below is a published operation in the engine's route catalogue
(`packages/contracts/src/routes.ts` on `contract/authoritative-v1.1`).

## Negotiation

`GET /v1/handshake` is fetched once per invocation, before any capability runs.
The SDK validates the document against `EngineHandshake` and then checks:

- the engine's contract major equals this SDK's major;
- the engine's contract is not older than 1.1.0;
- `eventSchemaVersion` matches the SDK's event schema;
- `chatStreamSchemaVersion` matches when present;
- this SDK satisfies `minSdkVersion`.

Any mismatch is `CONTRACT_INCOMPATIBLE` (exit `7`) and no capability request is
sent. `handshake.operations` is used as the authoritative operation set: a
family whose required operation is absent is `unverified`, never executed.

## Owner authentication

Every non-public operation requires `Authorization: Bearer <token>`. Public
operations are `getHealth`, `getReadiness` and `getHandshake`.

Owner authorization is enforced by the engine: a 401/403 becomes
`UNAUTHENTICATED` (exit `3`). The CLI additionally performs one owner-only read
(`GET /v1/agents`) during `readiness` so an operator can prove the token is
accepted for owner operations before submitting work.

## Operations used

| Operation | Method and path | Used for |
| --- | --- | --- |
| `getHealth` | `GET /v1/health` | readiness output |
| `getReadiness` | `GET /v1/ready` | readiness output |
| `getHandshake` | `GET /v1/handshake` | capability resolution, compatibility |
| `listAgents` | `GET /v1/agents` | owner proof, multi-agent discovery |
| `listModels` | `GET /v1/models` | model discovery |
| `submitWork` | `POST /v1/work` | every capability request |
| `getTask` | `GET /v1/work/{taskId}` | authoritative state, result, failure |
| `streamTaskEvents` | `GET /v1/work/{taskId}/events?after=N` | progress and replay |
| `cancelTask` | `POST /v1/work/{taskId}/cancel` | explicit cancellation and upload cleanup |
| `listTaskArtifacts` | `GET /v1/work/{taskId}/artifacts` | result listing |
| `uploadTaskArtifact` | `POST /v1/work/{taskId}/artifacts` | validated attachment storage |
| `getArtifact` | `GET /v1/artifacts/{artifactId}` | artifact metadata |
| `getArtifactContent` | `GET /v1/artifacts/{artifactId}/content` | digest-verified download |
| `listSchedules` | `GET /v1/schedules` | `schedules list` |
| `createSchedule` | `POST /v1/schedules` | `schedules create` |
| `getSchedule` | `GET /v1/schedules/{scheduleId}` | `schedules get` |
| `cancelSchedule` | `POST /v1/schedules/{scheduleId}/cancel` | `schedules cancel` |
| `listPendingPermissions` | `GET /v1/permissions` | `permissions list` |
| `decidePermission` | `POST /v1/work/{taskId}/permissions` | `permissions approve/deny` |

Routes that do **not** exist in contract 1.1.0 and are therefore not used:
`GET /v1/capabilities`, `POST /v1/capabilities/{id}/execute`, `POST /v1/files`,
`GET /v1/artifacts`, `POST /v1/artifacts/{id}/project`.

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
{ "path": "report.pdf", "mediaType": "application/pdf", "contentBase64": "..." }
```

- `path` must be relative, at most 1024 characters, with no `..` segment and no
  drive letter. The CLI reduces a local name to a safe basename.
- `contentBase64` is at most 12,000,000 characters; the CLI refuses local files
  above 8 MiB before reading them, staying under the decoded bound.
- The engine returns an `ArtifactRecord` with `bytes` and `digest`
  (`sha256:<64 hex>`). The CLI requires both to equal the local byte count and
  SHA-256; otherwise it cancels the task and reports
  `ARTIFACT_INTEGRITY_FAILED`.

Because `WorkSubmitRequest` has no attachment field, the order is: submit, then
upload to the accepted task. If the upload fails the task is cancelled, so no
run observes a missing input.

## Downloads

`GET /v1/artifacts/{artifactId}/content` returns
`{artifactId, mediaType, bytes, digest, contentBase64}`.

- The descriptor must match the metadata record; otherwise the download is
  refused before writing.
- The decoded bytes are hashed and compared with the published digest and byte
  count. A mismatch deletes the temporary file and leaves the destination
  untouched.
- The destination is resolved locally: `--out`, or the artifact basename in the
  current directory. `--force` is the only authorization to replace an existing
  file. Directories, missing parents and symlinks are refused.

## Progress

`streamTaskEvents` is an SSE stream with `id: <seq>` and an `ExecutionEvent`
body. The CLI applies events in sequence order, ignores an already-applied
sequence or event id, resumes with `after=<lastSeq>`, and reports
`x-coderax-truncated` when the engine says the retained window no longer
contains the cursor. When the deployment does not publish the stream, the CLI
polls `getTask` instead; that is a degradation, not a failure.

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
