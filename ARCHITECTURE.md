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

workflow commands (conversations / tasks / schedules / artifacts / ...)
  └─► capability-catalog.js (intent + contract)
        └─► command-surface.js
              ├─► discover.js (the deployment's OpenAPI operations)
              ├─► bindOperation (operationId or published path; never invented)
              ├─► schema validation (args, query, body, enums)
              └─► client.js (JSON, multipart upload, binary download)
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/config.js` | resolve, validate, persist deployment settings | filesystem, environment |
| `src/client.js` | one HTTP request, error mapping, redaction | `fetch` only |
| `src/discover.js` | find and summarize the OpenAPI document | client |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/product-commands.js` | chat, Work, products, Cloud, login, doctor | config, client, registry |
| `src/capability-catalog.js` | canonical command intents, binding rules, capability report | client (errors) |
| `src/command-surface.js` | bind and execute workflow commands, validate against the document, upload/download | catalog, discover, client |
| `src/completions.js` | bash / zsh / fish scripts generated from the catalog | catalog, client |
| `src/cli.js` | parsing, preflight, dispatch, output | all of the above |

Each layer is injectable: tests pass `fetchImpl`, `env`, `stdout`, and file
readers, so the suite runs offline and never touches a real deployment.

## Ordering rules

`preflight` runs before config resolution on purpose. `coderax deplyo` must say
"unknown command", not "no base URL configured". Usage errors exit `2`, so
scripts can separate a bad invocation from a failed deployment.

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
| cancelled by the caller | `CANCELLED` | 130 |

## Deliberate constraints

- No retries. A caller that wants retries wraps the command.
- No redirects: `redirect: "error"` prevents a token being forwarded to another host.
- No persistent HTTP agent, cookie jar, or telemetry.
- One request per command except the commands that discover first (`agents`,
  `models`, `openapi`, `capabilities`, and every workflow command).
- Workflow commands never guess a route. The catalog holds intents; the
  deployment's OpenAPI document holds concrete operations. No match means
  `OPERATION_NOT_FOUND` with zero requests to the missing path.
- No local state for conversations, tasks, schedules, memory, notifications or
  artifacts: both the CLI and Coderax Web read the deployment, so they cannot
  drift.
- Uploads are multipart under the `file` field; downloads are written with mode
  `0600`, atomically, and never overwrite without `--force`.
- The token is never serialized into output, config summaries, or error text.
