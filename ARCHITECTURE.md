# Architecture

```
argv ──► parseArgv ──► preflight ──► resolveSettings ──► command
                          │              │                │
                     usage errors   config.js        health / openapi /
                     (exit 2)       (env + file)     agents / models / call
                                                        │
                                                        ├─► discover.js (OpenAPI)
                                                        └─► client.js (HTTP + SSE)

product commands (chat / work / products / cloud / login / doctor)
  └─► product-commands.js ─► product-registry.js
                           ├─► client.js (HTTP + SSE)
                           └─► config.js (atomic 0600 config)

capability commands (capabilities / readiness / upload / analyze-* / create-*)
  └─► capability-commands.js ─► capability-registry.js ─► capability-catalog.js
                             ├─► sdk.js (/v1 tasks, events, uploads, artifacts)
                             ├─► file-transfer.js (validation, multipart, hashing)
                             └─► client.js (owner auth, Problem mapping, redaction)
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/config.js` | resolve, validate, persist deployment settings | filesystem, environment |
| `src/client.js` | one HTTP request, error mapping, redaction | `fetch` only |
| `src/discover.js` | find and summarize the OpenAPI document | client |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/product-commands.js` | chat, Work, products, Cloud, login, doctor | config, client, registry |
| `src/capability-catalog.js` | stable capability aliases, offline help, MIME defaults | none |
| `src/capability-registry.js` | decode/validate the engine registry, fail closed on drift | catalog, client |
| `src/capability-commands.js` | discovery, readiness, execution, wait/progress, artifacts | registry, sdk, transfer |
| `src/sdk.js` | WorkflowEngine `/v1` transport: tasks, events, uploads, artifacts | client |
| `src/file-transfer.js` | file validation, multipart bodies, hashed safe downloads | client, filesystem |
| `src/format.js` | shared table and byte formatting | none |
| `src/exit.js` | shared exit codes | none |
| `src/cli.js` | parsing, preflight, dispatch, output | all of the above |

Each layer is injectable: tests pass `fetchImpl`, `env`, `stdout`, and file
readers, so the suite runs offline and never touches a real deployment.

## Ordering rules

`preflight` runs before config resolution on purpose. `coderax deplyo` must say
"unknown command", not "no base URL configured". Usage errors exit `2`, so
scripts can separate a bad invocation from a failed deployment.

Capability options are not hardcoded. The parser collects unknown long options;
preflight rejects them for ordinary commands and the capability layer validates
them against the registry's `inputs` for capability commands. The CLI never
executes a capability the registry does not report as `available`; a missing
registry means every proposed capability is `blocked`.

## Failure semantics

| Condition | Code | Exit |
| --- | --- | --- |
| unknown command or flag misuse | `UsageError` | 2 |
| HTTPS violated, bad URL, bad timeout | `BASE_URL_*`, `TIMEOUT_INVALID` | 2 |
| no deployment configured | `BASE_URL_REQUIRED` | 1 |
| request timeout | `REQUEST_TIMEOUT` | 4 |
| redirect or network failure | `REQUEST_FAILED` | 4 |
| HTTP 401 or 403 | `HTTP_401`, `HTTP_403` | 3 |
| HTTP 404 | `HTTP_404` | 5 |
| other non-2xx response | `HTTP_<status>` | 1 |
| no OpenAPI document | `OPENAPI_NOT_FOUND` | 1 |
| route absent from the document | `OPERATION_NOT_FOUND` | 1 |
| Cloud or projects unavailable | `UNAVAILABLE` | 6 |
| capability missing, blocked, unconfigured or unverified | `CAPABILITY_NOT_AVAILABLE` | 6 |
| capability registry malformed or not version 1.x | `CAPABILITY_REGISTRY_INVALID`, `CAPABILITY_CONTRACT_INCOMPATIBLE` | 1 |
| local upload, input or destination validation | `CAPABILITY_INPUT_INVALID`, `UPLOAD_*`, `ARTIFACT_DESTINATION_*` | 2 |
| artifact digest or size mismatch | `ARTIFACT_INTEGRITY_FAILED` | 1 |
| cancelled by the caller | `CANCELLED` | 130 |

## Deliberate constraints

- No retries. A caller that wants retries wraps the command.
- No redirects: `redirect: "error"` prevents a token being forwarded to another host.
- No persistent HTTP agent, cookie jar, or telemetry.
- One request per command except `agents`/`models`, which discover first, and
  capability commands, which fetch the registry and then their declared routes.
- No provider adapter, model call, document parser, generator or local execution.
  The CLI only transfers inputs and renders engine results.
- Uploads and downloads are bounded and hashed; downloads never overwrite
  without explicit `--force`.
- The token is never serialized into output, config summaries, or error text.
