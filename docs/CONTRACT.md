# CLI ↔ deployment contract

Version: CLI `0.2.0`, targeting Coderax deployments that publish an OpenAPI 3.x
document and a WorkflowEngine capability registry (`docs/CAPABILITIES.md`).

## Authentication

The CLI sends `Authorization: Bearer <token>` on every request. The deployment is
responsible for issuing and revoking tokens, including the machine-client
identities described in the Coderax repository's Agent Management API surface.

The CLI adds no headers beyond `accept`, `authorization`, and `content-type` on
bodies, and it never forwards cookies.

## Discovery

Candidates, tried in order:

1. `/openapi.json`
2. `/api/openapi.json`
3. `/.well-known/openapi.json`

A candidate is accepted only when it is a JSON object with an `openapi` version
starting `3.`, a `paths` object, and at least one operation. The first accepted
document wins; failures from every candidate are reported when none is usable.
An `HTTP_401`, `HTTP_403`, or `REQUEST_TIMEOUT` is surfaced immediately instead
of being hidden behind `OPENAPI_NOT_FOUND`, so authentication and timeout
exit codes remain meaningful.

## Health

Candidates, tried in order: `/health`, `/api/health`, `/healthz`. A `404` or `405`
moves to the next candidate; any other failure is surfaced immediately, so an
authentication problem is not mistaken for a missing endpoint.

## Capability registry and execution

The capability surface is versioned separately from the deployment OpenAPI
document and follows WorkflowEngine contract `1.0.0`:

- `GET /v1/capabilities` — authoritative commands, options, statuses and artifact
  availability. Only `status: "available"` may execute.
- `POST /v1/capabilities/{capabilityId}/execute` — accepts
  `{capabilityId, inputs, projectId?, conversationId?, wait}` and returns the
  WorkflowEngine `TaskAccepted` shape.
- `GET /v1/work/{taskId}` — authoritative terminal state and result artifacts.
- `GET /v1/work/{taskId}/events?after=N` — sequenced SSE progress; duplicate
  event ids and `seq <= after` are ignored.
- `POST /v1/files` — multipart upload (`file`, `sha256`, `bytes`, `mimeType`,
  optional project/conversation), with `x-content-sha256`; the response must echo
  the byte count and digest.
- `GET /v1/artifacts`, `GET /v1/artifacts/{id}`,
  `GET /v1/artifacts/{id}/content`, `POST /v1/artifacts/{id}/project` — the same
  owner-scoped catalog Coderax Web uses.

A registry that is absent, malformed or from another major version does not
degrade to a local implementation: every proposed capability is reported
`blocked` (missing) or the command fails (`CAPABILITY_REGISTRY_INVALID`,
`CAPABILITY_CONTRACT_INCOMPATIBLE`). Unknown statuses become `unverified`.

Execution is never retried by the CLI. `--no-wait` leaves the durable task
running; closing the terminal does not cancel it. `--wait-timeout` only stops
local waiting.

## Uploads and downloads

Uploads are regular files only, non-empty, within the registry limit (50 MiB hard
cap), with extension and magic bytes in agreement and a MIME type the registry
accepts. The exact sent bytes are hashed with SHA-256 and the engine must echo
the same digest and byte count.

Artifact downloads require a published SHA-256 digest. Data is streamed into a
temporary or exclusively created file, hashed, checked against the digest and
byte count, and only then moved into place. A mismatch removes the data. Existing
files are never replaced without `--force`; directories, missing parents and
symbolic-link destinations are refused.

## Convenience routes

| Command | Match rule |
| --- | --- |
| `agents` | first `GET` operation whose path ends in `/agents` |
| `models` | first `GET` operation whose path ends in `/models` |

No path is hardcoded. When the match is absent the CLI exits `1` with
`OPERATION_NOT_FOUND` and suggests `coderax openapi`.

## Requests

- Route paths are appended beneath the configured deployment prefix, so
  `--base-url https://example.com/coderax` requests
  `https://example.com/coderax/health`, not `https://example.com/health`.
- `call <METHOD> <PATH> [--data <json>]` — `--data` is rejected on `GET`/`HEAD`.
- Bodies are serialized as JSON; responses are parsed as JSON when possible and
  shown verbatim otherwise.
- Timeout: 15s default, `--timeout` or `CODERAX_TIMEOUT_MS` to override.
- Redirects are refused.

## Exit codes

- `0` success
- `1` other operational failure (missing operation, unavailable health check,
  other non-2xx HTTP status)
- `2` usage error or invalid configuration
- `3` HTTP 401/403 authentication or authorization failure
- `4` network failure or timeout
- `5` HTTP 404 not found
- `6` Cloud/projects unavailable, or a capability not available/registry missing
- `2` local capability input, upload or download-destination validation
- `1` capability task failure, artifact integrity failure, contract mismatch
- `130` cancelled locally (a durable cloud task continues)

## Compatibility

The CLI depends only on the OpenAPI document shape and bearer auth. Adding routes
to a deployment does not require a CLI release; removing a route degrades the
matching command to `OPERATION_NOT_FOUND` while `coderax call` keeps working.
