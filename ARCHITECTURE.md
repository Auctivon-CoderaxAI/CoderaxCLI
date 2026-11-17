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
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/config.js` | resolve, validate, persist deployment settings | filesystem, environment |
| `src/client.js` | one HTTP request, error mapping, redaction | `fetch` only |
| `src/discover.js` | find and summarize the OpenAPI document | client |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/product-commands.js` | chat, Work, products, Cloud, login, doctor | config, client, registry |
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
| request timeout | `REQUEST_TIMEOUT` | 1 |
| redirect encountered | `REQUEST_FAILED` | 1 |
| non-2xx response | `HTTP_<status>` | 1 |
| no OpenAPI document | `OPENAPI_NOT_FOUND` | 1 |
| route absent from the document | `OPERATION_NOT_FOUND` | 1 |

## Deliberate constraints

- No retries. A caller that wants retries wraps the command.
- No redirects: `redirect: "error"` prevents a token being forwarded to another host.
- No persistent HTTP agent, cookie jar, or telemetry.
- One request per command except `agents`/`models`, which discover first.
- The token is never serialized into output, config summaries, or error text.
