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

## Interactive terminal transport (provisional)

The terminal consumes a facade with a deliberately small surface:

```js
getCapabilities() -> {
  contractVersion, contractVerified, stream, work, tools, attachments,
  conversations, permissions, verifiedPermissions, models, agents,
  modelSelection, agentSelection
}
streamMessage({ mode, text, model, agent, conversationId, attachments,
                signal, onEvent })
respondPermission(payload)
listModels(), listAgents(), listConversations(), close()
```

Events are `delta`, `replace`, `final`, `tool`, `progress`, `permission` and
`conversation`. The presentation layer does not route models or run workflows;
it only renders these events and passes selections through.

The legacy SSE transport remains the default. `CODERAX_SDK=canonical` requires
`contractVersion` `coderax-sdk/1`, `contractVerified: true` and streaming
support; a mismatch exits with `SDK_CONTRACT_MISMATCH` rather than falling back
silently. `CODERAX_SDK=auto` falls back to legacy until that handshake succeeds.
This contract is provisional until the gateway and WorkflowEngine owners verify
it end to end.

## Permission approval (provisional)

A permission request is actionable only when all of these are present:

- `serverIssued: true`, received on the authenticated SSE/SDK channel
- `requestId` issued by the server
- `executionId` identifying the engine execution
- `action` from the allowed set (`read_file`, `write_file`, `delete_file`,
  `list_directory`, `run_command`, `network`, `send_files`, `use_tool`)
- `resource` that canonicalises to an absolute path, URL or exact command
- optional `expiresAt` and `resourceHash`; a supplied hash must match

The response is `{ requestId, executionId, action, resourceHash, decision,
decidedAt }`. Session approval applies to that exact tuple only. The legacy
transport declares `permissions: false` and fails closed.

## Compatibility

The CLI depends only on the OpenAPI document shape and bearer auth. Adding routes
to a deployment does not require a CLI release; removing a route degrades the
matching command to `OPERATION_NOT_FOUND` while `coderax call` keeps working.
