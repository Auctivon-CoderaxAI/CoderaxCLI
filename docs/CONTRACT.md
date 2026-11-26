# CLI ↔ deployment contract

Version: CLI `0.1.0`, targeting Coderax deployments that publish an OpenAPI 3.x
document.

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

## Convenience routes

| Command | Match rule |
| --- | --- |
| `agents` | first `GET` operation whose path ends in `/agents` |
| `models` | first `GET` operation whose path ends in `/models` |
| `whoami` | fixed `GET /api/user`, the same identity route `login` uses |

No path is hardcoded. When the match is absent the CLI exits `1` with
`OPERATION_NOT_FOUND` and suggests `coderax openapi`.

## Workflow command contract

`src/capability-catalog.js` declares the command intents. A deployment's
OpenAPI document is the only source of concrete operations; the `contract`
strings below describe the shape the CLI needs, not a path the CLI calls
directly.

### Binding

A command binds to at most one operation, in this order:

1. `--operation <operationId>` (or `--operation "METHOD /path"`) — explicit and
   intentional.
2. An exact `operationId` from the command's list, for the command's methods.
3. The command's path pattern against the published path, for those methods.

When nothing matches, nothing is sent and the command exits `1` with
`OPERATION_NOT_FOUND`. When two equally specific operations match, the command
exits `1` with `OPERATION_AMBIGUOUS` and lists the candidates; rerun with
`--operation`. `coderax capabilities` prints every binding and is the
machine-readable source of truth for availability.

### Published shapes

| Command | Contract |
| --- | --- |
| `conversations list` / `show` | `GET /conversations`, `GET /conversations/{id}` |
| `tasks list` / `show` | `GET /tasks`, `GET /tasks/{id}` |
| `tasks cancel` / `retry` / `resume` / `detach` | `POST /tasks/{id}/cancel` and siblings |
| `permissions list` / `show` | `GET /permissions`, `GET /permissions/{id}` |
| `memory list` / `show` / `delete` | `GET /memory`, `GET /memory/{id}`, `DELETE /memory/{id}` |
| `schedules list` / `show` / `create` / `update` / `pause` / `resume` / `delete` | `GET|POST /schedules`, `GET|PATCH|DELETE /schedules/{id}`, `POST /schedules/{id}/pause|resume` |
| `notifications list` / `read` | `GET /notifications`, `POST /notifications/{id}/read` |
| `artifacts list` / `show` / `upload` / `download` / `delete` | `GET|POST /artifacts`, `GET|DELETE /artifacts/{id}`, `GET /artifacts/{id}/content` |
| `plugins list` / `show` | `GET /plugins`, `GET /plugins/{id}` |
| `tools list` / `show` / `invoke` | `GET /tools`, `GET /tools/{id}`, `POST /tools/{id}/invoke` |
| `projects list` | `GET /projects` |
| `capabilities` | optional `GET /capabilities` (server capability document) |

The path patterns are matched against the published document, so a deployment
that prefixes routes (`/api/v1/...`) or nests them (`/api/work/tasks/...`)
still binds. A deployment that uses unrelated paths can be driven with
`--operation` without a CLI release.

### Request rules

- Path template parameters are filled from positional arguments in template
  order. The count must match; values are percent-encoded.
- Query: `--limit`, `--cursor`, `--query`, `--status` and repeatable
  `--param key=value` are sent only when the operation declares that query
  parameter. If the document declares query parameters, an undeclared flag is a
  usage error; if it declares none, what the user asked for is sent.
- Body: `--data <json>` or field flags (never both). Required fields from the
  command contract and from the operation's inline JSON schema must be present.
  Declared types, enums and `additionalProperties: false` are enforced. `$ref`
  bodies are not resolved; the command contract still applies.
- `schedules create` requires `cron` and `prompt`. `schedules update` requires at
  least one field.
- `artifacts upload` sends `multipart/form-data` with the file in the `file`
  field. The upload operation must declare a multipart request body or no body;
  a JSON-only upload operation is reported as `UPLOAD_UNSUPPORTED` instead of
  being attempted.
- `artifacts download` writes atomically with mode `0600` and refuses to
  overwrite an existing path without `--force`.
- Destructive commands require `--yes`.

### Output

Workflow commands use one envelope under `--json`:

```json
{
  "command": "tasks cancel",
  "capability": "tasks",
  "operation": { "method": "POST", "path": "/api/tasks/{taskId}/cancel", "operationId": "cancelTask" },
  "status": 200,
  "data": { "id": "task-1", "status": "cancelled" },
  "meta": { "count": 1 }
}
```

`meta.count`/`meta.total`/`meta.nextCursor` are present for lists, and
`meta.file` for uploads and downloads. Human output uses tables for lists and
formatted JSON for resources.

With `--json`, failures print one JSON object to stderr:

```json
{"error":{"code":"OPERATION_NOT_FOUND","message":"...","command":"tasks list"}}
```

Legacy commands keep their existing JSON shapes for backward compatibility.

### Parity with Coderax Web

Workflow commands hold no local data. Conversations, tasks, schedules, memory,
notifications, permissions and artifacts live only on the deployment that also
serves Coderax Web, so both clients see the same objects.

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
- `1` other operational failure (missing operation, ambiguous binding,
  unsupported upload, unavailable health check, other non-2xx HTTP status)
- `2` usage error, invalid configuration, missing `--yes`, invalid local file
- `3` authentication or authorization failure (HTTP 401/403, no token)
- `4` network failure or timeout
- `5` HTTP 404 not found
- `6` Cloud/projects fallback unavailable
- `130` cancelled

## Compatibility

The CLI depends only on the OpenAPI document shape and bearer auth. Adding routes
to a deployment does not require a CLI release; removing a route degrades the
matching command to `OPERATION_NOT_FOUND` while `coderax call` keeps working.
