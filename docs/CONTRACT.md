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

`0` success · `1` operational failure · `2` usage or configuration error.

## Compatibility

The CLI depends only on the OpenAPI document shape and bearer auth. Adding routes
to a deployment does not require a CLI release; removing a route degrades the
matching command to `OPERATION_NOT_FOUND` while `coderax call` keeps working.
