# Architecture

```
argv ──► parseArgv ──► preflight ──► resolveSettings ──► command
                          │              │                │
                     usage errors   config.js        health / openapi /
                     (exit 2)       (env + file)     agents / models / call
                                                        │
                                                        ├─► discover.js (OpenAPI)
                                                        └─► client.js (HTTP + SSE)

product commands (chat / work / products / cloud / login / doctor / history)
  └─► product-commands.js ─► product-registry.js
                           ├─► client.js (HTTP + SSE)
                           ├─► config.js (atomic 0600 config)
                           └─► terminal/history.js

interactive.js ─► terminal/session.js ─► sdk.js ─► sdk-legacy.js (SSE)
                        │                 └─► @coderax/sdk (verified only)
                        ├─► terminal/renderer.js ─► terminal/editor.js
                        ├─► terminal/markdown.js ─► terminal/highlight.js
                        ├─► terminal/permissions.js
                        └─► terminal/attachments.js
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/config.js` | resolve, validate, persist deployment settings | filesystem, environment |
| `src/client.js` | one HTTP request, error mapping, redaction | `fetch` only |
| `src/discover.js` | find and summarize the OpenAPI document | client |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/product-commands.js` | chat, Work, products, Cloud, login, doctor, history | config, client, registry |
| `src/cli.js` | parsing, preflight, dispatch, output | all of the above |
| `src/sdk.js` | transport facade and contract gate | legacy adapter |
| `src/sdk-legacy.js` | current SSE transport adapter | client, discovery |
| `src/interactive.js` | TTY raw mode, resize, accessible input | terminal modules, sdk |
| `src/terminal/session.js` | interactive Chat/Work orchestration | renderer, editor, stores |
| `src/terminal/renderer.js` | prompt region, bounded block, accessible output | text, theme |
| `src/terminal/markdown.js` | streaming markdown, highlighting, preview | sanitize, text, highlight |
| `src/terminal/editor.js` | grapheme-safe multiline editing | text |
| `src/terminal/keys.js` | key/paste parsing | none |
| `src/terminal/history.js` | prompt and conversation metadata storage | secure-store |
| `src/terminal/permissions.js` | verified approval binding | sanitize |
| `src/terminal/attachments.js` | explicit local-file review | sanitize |
| `src/secure-store.js` | cross-platform private file verification | OS ACL tools |

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

## Terminal memory bounds

The renderer keeps only the last response block (200 rows / 64 KiB) for resize
reflow; earlier output belongs to the terminal's scrollback. Markdown rendering
is capped at 2 MiB with an explicit truncation notice, code blocks at 4000
lines, tool activity at 200 events, conversations at 50 records, prompt history
at its configured limit, and the editor at 100 000 characters / 200 lines.

## Deliberate constraints

- No retries. A caller that wants retries wraps the command.
- No redirects: `redirect: "error"` prevents a token being forwarded to another host.
- No persistent HTTP agent, cookie jar, or telemetry.
- One request per command except `agents`/`models`, which discover first.
- The token is never serialized into output, config summaries, or error text.
