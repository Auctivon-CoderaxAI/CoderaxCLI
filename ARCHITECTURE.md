# Architecture

```
argv ──► parseArgv ──► preflight ──► resolveSettings ──► command
                          │              │                │
                     usage errors   config.js        health / openapi /
                     (exit 2)       (env + file)     agents / models / call
                                                        │
                                                        ├─► discover.js (OpenAPI)
                                                        └─► client.js (HTTP + SSE)

auth commands (login / logout / whoami / auth status / status / doctor)
  └─► product-commands.js ─► auth.js ─► credentials.js (OS store)
                                │
                                ├─► client.js (HTTP + form + SSE)
                                ├─► discover.js (auth endpoints, identity)
                                └─► config.js (URL/settings only; no secrets)

chat / work
  └─► product-commands.js ─► auth.js (resolve session, refresh, scope)
                                 └─► client.js (SSE with redaction)
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/config.js` | resolve, validate, persist non-secret deployment settings; detect/strip a legacy plaintext token | filesystem, environment |
| `src/credentials.js` | OS credential store providers (Keychain, libsecret, DPAPI); no plaintext fallback | subprocesses, filesystem, OS facilities |
| `src/auth.js` | sessions, device authorization, refresh, revocation, scopes, endpoint verification, origin binding | client, discovery, config, credentials |
| `src/client.js` | one HTTP request, error mapping, multi-secret redaction, SSE | `fetch` only |
| `src/discover.js` | find and summarize the OpenAPI document | client |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/product-commands.js` | chat, Work, products, Cloud, login, logout, whoami, status, doctor | auth, client, registry, config |
| `src/cli.js` | parsing, preflight, dispatch, output | all of the above |

Each layer is injectable: tests pass `fetchImpl`, `env`, `stdout`, a credential
store, clock/sleep functions, and file readers, so the suite runs offline and
never touches a real deployment or keychain.

## Authentication flow

1. **Discover** the deployment's OpenAPI document (optional). Auth routes are
   resolved from it, falling back to the documented contract paths.
2. **Verify identity** before storing anything: a health response or the OpenAPI
   document must name Coderax.
3. **Device authorization**: POST a device-code request, print the verification
   URL and user code, optionally open the browser, then poll at the advertised
   interval. `authorization_pending` and `slow_down` are handled; `access_denied`
   and `expired_token` are terminal.
4. **Validate the issued session**: access token present, Bearer type, JWT `iss`
   matches the deployment origin, scopes read from the response or claims.
5. **Persist** the credential bundle in the OS store, keyed by a hash of the
   deployment URL. The URL is also saved in the non-secret config. A legacy
   plaintext token is removed.
6. **Use** the session: refresh when within 60 seconds of expiry, enforce the
   command's scope, and retry once on HTTP 401 after a refresh.
7. **Logout**: revoke refresh and access tokens when advertised, delete the local
   credential even if revocation fails, and remove any legacy plaintext token.

## Ordering rules

`preflight` runs before config resolution on purpose. `coderax deplyo` must say
"unknown command", not "no base URL configured". Usage errors exit `2`, so
scripts can separate a bad invocation from a failed deployment.

Authentication resolution runs before the first API request of a command, so an
unauthenticated or under-scoped invocation performs no network call at all.
`health` and `openapi` degrade to anonymous access instead, because they are
useful for diagnostics before login.

## WorkflowEngine integration

Work mode uses the same `authorizedStream` path as Chat. The session is resolved
and refreshed **before** the stream starts, and a `401` before any event is
retried once with a refreshed token. A stream that has already emitted events is
never silently restarted; mid-stream failures surface as `STREAM_ERROR` or
`REQUEST_FAILED`. The deployment remains responsible for checking the bearer
token and the `coderax:work` scope on every Work request. See
[docs/CONTRACT.md](docs/CONTRACT.md) for the server-side contract.

## Failure semantics

| Condition | Code | Exit |
| --- | --- | --- |
| unknown command or flag misuse | `UsageError` | 2 |
| HTTPS violated, bad URL, bad timeout | `BASE_URL_*`, `TIMEOUT_INVALID` | 2 |
| credential store unavailable or locked | `CREDENTIAL_STORE_UNAVAILABLE`, `CREDENTIAL_STORE_LOCKED` | 2 |
| TLS verification disabled | `TLS_VERIFICATION_DISABLED` | 2 |
| token argument rejected | `--token` usage error | 2 |
| no deployment configured | `BASE_URL_REQUIRED` | 1 |
| no session | `UNAUTHENTICATED` | 3 |
| expired or rejected session | `SESSION_EXPIRED` | 3 |
| missing scope | `INSUFFICIENT_SCOPE` | 3 |
| issuer/origin/subject mismatch | `TOKEN_*`, `CREDENTIAL_ORIGIN_MISMATCH`, `IDENTITY_MISMATCH` | 3 |
| device access denied | `DEVICE_ACCESS_DENIED` | 3 |
| endpoint identity not verified | `ENDPOINT_UNVERIFIED` | 1 |
| device flow unsupported | `DEVICE_AUTH_UNSUPPORTED` | 1 |
| deployment did not expose refresh | `REFRESH_UNSUPPORTED` | 3 |
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

- No plaintext credential file, no token in argv, no provider API keys.
- No retries except one refresh-and-retry after an authentication failure. A
  caller that wants retries wraps the command.
- No redirects: `redirect: "error"` prevents a token being forwarded to another host.
- No persistent HTTP agent, cookie jar, or telemetry.
- One request per command except `agents`/`models`, which discover first.
- The token is never serialized into output, config summaries, or error text.
- Client-side scope checks apply only when the deployment reports scopes; the
  deployment is still the authority for every request.
