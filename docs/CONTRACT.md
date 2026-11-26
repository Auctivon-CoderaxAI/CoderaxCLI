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
- `6` Cloud/projects unavailable
- `130` cancelled

## Compatibility

The CLI depends only on the OpenAPI document shape and bearer auth. Adding routes
to a deployment does not require a CLI release; removing a route degrades the
matching command to `OPERATION_NOT_FOUND` while `coderax call` keeps working.

## WorkflowEngine version reporting

A deployment should report the WorkflowEngine version in one of these places,
in order of preference:

1. `GET /health` (or `/api/health`, `/healthz`):
   `workflowEngine.version`, `workflowEngineVersion`, `engine.version`,
   `services.workflowEngine.version`, or `capabilities.workflowEngine`.
2. The OpenAPI document's `info.version`.

A bare top-level `version` in a health response is ignored: it commonly
identifies the web service, not the engine, and using it would produce a wrong
compatibility verdict.

CLI release `0.2.0` supports `>=0.8.0 <1.0.0`. Prerelease engine versions are
reported as unsupported. When no version is reported, compatibility is
`unknown`, which is distinct from `incompatible`: `coderax compat` exits `1`
for both, but `coderax doctor` only fails when the reported version is outside
the range.

The CLI does not block commands on a failed compatibility check. Automation that
must enforce the range should run `coderax compat --json` and treat a non-zero
exit code as fatal.

`info.version` is therefore part of the contract, not decoration: a deployment
that changes it across a major boundary signals a potentially breaking engine
surface to every CLI in the field.
