# CLI ↔ deployment contract

Version: CLI `0.1.0`, targeting Coderax deployments that publish an OpenAPI 3.x
document.

This document is the coordination point between the CLI, the API contract owners
and the WorkflowEngine. The authentication shapes below are the approved
standards — RFC 8628 (device authorization), RFC 6749 (token responses and
refresh) and RFC 7009 (revocation) — not a bespoke protocol. The deployment owns
issuance, refresh, revocation, identity and scope enforcement; the CLI only
carries and protects the resulting session.

## Authentication

### Client and credential handling

- The CLI is a public client with `client_id` `coderax-cli`. It has no client
  secret and never asks for a provider API key.
- Credentials are stored in the operating-system credential store. The config
  file contains only the deployment URL and non-secret settings.
- Tokens are never accepted as command arguments; they arrive through device
  authorization, stdin (`login --with-token`) or `CODERAX_TOKEN`.
- The CLI sends `Authorization: Bearer <token>` on authenticated requests. It
  adds no headers beyond `accept`, `authorization`, `content-type` and the
  standard form content type on token requests, and never forwards cookies.

### Device authorization

Canonical routes (an OpenAPI document may advertise different paths; see below):

| Purpose | Method and path |
| --- | --- |
| Device authorization | `POST /api/auth/device/code` |
| Device token polling | `POST /api/auth/device/token` |
| Token refresh | `POST /api/auth/token/refresh` |
| Token revocation | `POST /api/auth/token/revoke` |
| UserInfo | `GET /api/user` |

All auth routes are form-encoded and same-origin with the configured deployment.

**Device authorization request**

```http
POST /api/auth/device/code
Content-Type: application/x-www-form-urlencoded

client_id=coderax-cli&scope=coderax%3Achat+coderax%3Awork+coderax%3Aagents%3Aread+coderax%3Amodels%3Aread+coderax%3Acall
```

**Response** (`200`, RFC 8628 §3.2):

```json
{
  "device_code": "opaque-device-code",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://coderax.example.com/device",
  "verification_uri_complete": "https://coderax.example.com/device?code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

- `verification_uri` must be on the deployment origin and use HTTPS (loopback
  HTTP is allowed for development). A different origin is rejected before the
  user is sent there.
- `user_code` is displayed to the user; `device_code` is never printed.
- `interval` defaults to 5 seconds and is clamped to 1–60. `expires_in` defaults
  to 600 seconds and is clamped to 1–3600.

**Polling request**

```http
POST /api/auth/device/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=opaque-device-code&client_id=coderax-cli
```

- `authorization_pending` (`400`) keeps polling at the interval.
- `slow_down` (`400` or `429`) increases the interval by 5 seconds, capped at 60.
- `access_denied`, `expired_token` and `invalid_grant` are terminal.
- A successful poll returns the token response below.

**Token response** (`200`, RFC 6749 §5.1):

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "opaque-refresh-token",
  "scope": "coderax:chat coderax:work coderax:agents:read coderax:models:read coderax:call"
}
```

`token_type` must be `Bearer` (case-insensitive). `expires_in` is optional; when
absent the CLI uses the JWT `exp`, or a 12-hour local limit for an opaque token.
`refresh_token` is optional for read-only or short-lived sessions.

### Refresh

```http
POST /api/auth/token/refresh
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=opaque-refresh-token&client_id=coderax-cli
```

The response uses the same token-response shape. The CLI:

- refreshes when the access token is within 60 seconds of expiry;
- refreshes once and retries once after an unexpected `401`;
- replaces a rotated `refresh_token` atomically, or keeps the old one if the
  server does not return a new one;
- rejects a response that grants a scope not present in the previous session
  (`CREDENTIAL_SCOPE_ESCALATION`);
- deletes the local credential on `invalid_grant`, `invalid_token`,
  `expired_token`, `access_denied`, or a `401` from the refresh endpoint.

A refresh must not be required in the middle of an active Work stream; see
WorkflowEngine integration below.

### Revocation

```http
POST /api/auth/token/revoke
Content-Type: application/x-www-form-urlencoded

token=opaque-token&token_type_hint=refresh_token&client_id=coderax-cli
```

The CLI revokes the refresh token first, then the access token, and sends the
access token as the bearer credential when available. RFC 7009 permits `200` for
unknown or already-revoked tokens. `404`/`405` is recorded as unsupported. A
failed revocation does not prevent local credential deletion, but the CLI warns
that the server token may remain valid until expiry.

### UserInfo

```http
GET /api/user
Authorization: Bearer <access_token>
```

A JSON object with any of `email`, `username`, `preferred_username`, `name`,
`sub` or `id` (optionally under `user`). `404` means the route is not exposed;
the CLI falls back to JWT claims. `401`/`403` is an authentication failure.
`whoami` rejects a response whose `sub` differs from the stored session subject.

### Discovery overrides

The CLI reads the OpenAPI document and matches operations by `operationId` or
path before falling back to the canonical routes above. Only relative,
same-origin paths without query strings, fragments, backslashes or `..` segments
are accepted; anything else is ignored.

Recognised operation IDs and suffixes:

| Purpose | Operation IDs (case-insensitive) | Path suffixes |
| --- | --- | --- |
| device authorization | `deviceAuthorization`, `startDeviceAuthorization`, `deviceCode` | `/device/code`, `/device/authorization`, `/device_authorization` |
| device token | `deviceToken`, `pollDeviceToken`, `deviceAccessToken` | `/device/token`, `/device/access_token` |
| refresh | `refreshToken`, `refreshAccessToken` | `/token/refresh`, `/refresh` |
| revoke | `revokeToken`, `revokeAccessToken` | `/token/revoke`, `/revoke` |
| userinfo | `userinfo`, `currentUser`, `getUser` | `/user`, `/userinfo` |

### Endpoint identity

Before starting device authorization or storing a token, the CLI requires the
deployment to identify itself as Coderax. Either:

- a health route (`/health`, `/api/health`, `/healthz`) returns a JSON
  `service`, `name`, `product` or `application` containing “Coderax”; or
- the OpenAPI `info.title` or `info.description` contains “Coderax”.

If neither is available, login fails with `ENDPOINT_UNVERIFIED` and nothing is
stored. Deployments that require authentication on every route must expose at
least one of these identity markers before login.

### Scopes

The CLI requests these scopes and enforces them when the issued token reports
scopes (`scope` in the token response, or `scope`/`scp` in the JWT):

| Command | Required scope |
| --- | --- |
| `chat` | `coderax:chat` |
| `work` | `coderax:work` |
| `agents` | `coderax:agents:read` |
| `models` | `coderax:models:read` |
| `call` | `coderax:call` |

`coderax:*` is a wildcard. `coderax:admin` is not requested by the CLI and must
never be required for the commands above. A token without scope information is
treated as legacy/unscoped and relies entirely on server enforcement; the CLI
reports `scopesKnown: false` in `auth status`.

**The deployment must enforce the bearer token and required scope on every
request.** The CLI check is defense in depth, not the authorization boundary.

### Errors

OAuth errors use the RFC 6749 shape:

```json
{ "error": "authorization_pending", "error_description": "..." }
```

`error_description` is diagnostic only and is redacted before display. HTTP
authentication failures should use RFC 6750 `WWW-Authenticate` challenges:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="expired"

HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="coderax:work"
```

The CLI maps `401` to `SESSION_EXPIRED` (after one refresh attempt) and
`insufficient_scope` to `INSUFFICIENT_SCOPE`. Other `403` responses map to
`FORBIDDEN`.

### WorkflowEngine integration

Work mode (`POST /api/work/chat`) shares the Chat SSE contract and the session
layer. The WorkflowEngine must:

1. Validate the bearer token and `coderax:work` before the first SSE byte. A
   pre-stream `401` lets the CLI refresh and retry once; a `403` with
   `insufficient_scope` is terminal.
2. Never require a token refresh during an active stream. A refresh issued
   mid-stream must not invalidate the token already accepted for that stream.
3. Report an authentication failure during a stream as an SSE `error` event and a
   terminal `final`, not as an HTML login page. The CLI surfaces it as
   `STREAM_ERROR`.
4. Treat the `final` event as authoritative, including `responseMessage.text`
   when the engine rewrote the answer. The CLI uses that text as the answer.
5. Revocation terminates refresh ability. An already-running stream may finish
   under the accepted token, but new Work calls must fail with `401`.

The CLI resolves and refreshes the session before opening the stream. A stream
that already emitted events is never silently restarted.

### Coordination checklist

For API contract owners:

- [ ] Confirm or implement the device, token, refresh, revoke and userinfo routes.
- [ ] Return RFC 8628/6749/7009 shapes and `WWW-Authenticate` challenges.
- [ ] Issue tokens whose `iss` matches the deployment origin; include `exp` and
      `scope`/`scp` where possible.
- [ ] Enforce scopes server-side; never rely on the CLI check.
- [ ] Keep identity markers available before login.
- [ ] Revoke refresh and access tokens independently and idempotently.

For WorkflowEngine owners:

- [ ] Reject unauthenticated and under-scoped Work requests before streaming.
- [ ] Emit SSE `error` + `final` for auth failures, never HTML.
- [ ] Honour in-flight streams during token refresh.
- [ ] Apply the `final`/`responseMessage.text` precedence and cumulative snapshot
      semantics the CLI already consumes.

For CLI owners:

- [ ] Keep credentials in the OS store, never in config or argv.
- [ ] Keep origin/issuer binding and endpoint verification before storage.
- [ ] Keep the 60-second refresh window and one-retry rule.
- [ ] Keep revocation best-effort with guaranteed local deletion.


### Shared WorkflowEngine SDK

`packages/workflow-sdk` is the authoritative client contract for Work/chat,
durable runs, approvals, cancellation and SSE. CLI command modules import that
package directly; they do not maintain a second workflow transport. The OAuth
authentication endpoints above are a separate protocol layer because they issue
the session that the SDK transport consumes. The SDK sends the same
`Authorization: Bearer` header and rejects redirects and cross-origin routes.

Coordination with the gateway and WorkflowEngine owners must confirm:

- the exact auth routes and RFC 8628/6749/7009 response shapes;
- server-side signature, issuer, audience, expiry, subject and owner checks;
- scope enforcement on every Work, chat, task, run, approval, repository and
  cloud-execution route;
- device-code single use, bounded lifetime and polling/replay behaviour;
- SSE auth-failure and revocation semantics without restarting a write.

Until confirmed, the routes in this document are proposed and are not evidence
of a deployed backend.

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
- Tokens are never accepted in a query string or command argument.

## Exit codes

- `0` success
- `1` other operational failure (missing operation, unavailable health check,
  unverified endpoint, other non-2xx HTTP status)
- `2` usage error or invalid configuration (bad URL, insecure transport,
  credential store unavailable, disabled TLS verification, token argument)
- `3` authentication or authorization failure (no session, expired session,
  insufficient scope, HTTP 401/403)
- `4` network failure or timeout
- `5` HTTP 404 not found
- `6` Cloud/projects unavailable
- `130` cancelled

## Compatibility

The CLI depends only on the OpenAPI document shape, bearer auth and the
standards-based auth routes above. Adding routes to a deployment does not
require a CLI release; removing a route degrades the matching command to
`OPERATION_NOT_FOUND` while `coderax call` keeps working. A deployment without
device authorization can still be used with `login --with-token` or
`CODERAX_TOKEN`; the CLI reports `DEVICE_AUTH_UNSUPPORTED` rather than inventing
an insecure login path.
