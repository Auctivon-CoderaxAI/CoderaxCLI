# Coderax CLI

Command-line client for a Coderax deployment. It signs in with device
authorization, stores credentials in the operating-system credential store,
chats and runs Work mode, lists products, agents and models, checks health, reads
the deployment's own OpenAPI document, and issues authenticated calls.

This repository is the **canonical** Coderax CLI. The in-repo `Coderax/cli`
package is deprecated; it is replaced by this implementation.

- Repository: `Auctivon-CoderaxAI/Coderax-CLI`
- Runtime: Node.js 24, standard library only, no runtime dependencies
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (deployment)

## Authentication

`coderax login` uses the deployment's device authorization flow (RFC 8628).
The CLI prints a verification URL and a user code, opens the browser when
possible, and waits for approval. The user approves on the deployment's own
origin; no token is typed into the terminal and none appears in shell history.

Credentials are stored only in an OS facility:

| Platform | Store |
| --- | --- |
| macOS | Keychain via `/usr/bin/security` (secret passed on stdin, not argv) |
| Linux | Secret Service via `secret-tool` (secret passed on stdin) |
| Windows | DPAPI, CurrentUser scope |

There is no plaintext-file fallback. If no store is available, the CLI refuses
to persist credentials and tells you to install `libsecret-tools` or use
`CODERAX_TOKEN` for automation. `coderax config set --token` and `--token`
arguments are rejected: arguments are recorded in shell history.

For headless deployments and CI, pipe a deployment-issued session token:

```sh
printf '%s' "$CODERAX_SESSION_TOKEN" | coderax login --with-token
```

`--with-token` still requires an OS credential store. On a keyring-less CI
runner, use `CODERAX_TOKEN` directly instead; it is read for that process and
never written to disk.

The CLI never asks for, accepts, or stores provider API keys (OpenAI, Anthropic
and so on). Provider credentials belong in an authorized cloud secret store and
are never part of this CLI's configuration.

## Why paths are discovered, not hardcoded

Coderax exposes its API through an OpenAPI document with Swagger UI. This CLI
reads that document for `openapi`, `agents`, and `models`. If a deployment does
not expose one of those routes, the CLI says so (`OPERATION_NOT_FOUND`) instead
of sending a request to a guessed path. `health` probes fixed paths, `login`
resolves the deployment's auth contract, `doctor` checks `/api/health`, `chat`
and `work` use the configured chat path, and `coderax call` uses the path you
supply.

## Status

| Capability | Status |
| --- | --- |
| Device authorization with browser approval | ✅ implemented, tested |
| OS credential store (Keychain / libsecret / DPAPI) | ✅ implemented, tested |
| Legacy plaintext-token migration and removal | ✅ implemented, tested |
| Session expiration and refresh with rotation | ✅ implemented, tested |
| Token revocation on logout | ✅ implemented, tested |
| Origin-bound credentials and endpoint verification | ✅ implemented, tested |
| Client-side scope enforcement | ✅ implemented, tested |
| `login` / `logout` / `whoami` / `auth status` | ✅ implemented, tested |
| `config show` / `config set` with `0600` persistence | ✅ implemented, tested |
| Environment precedence (`CODERAX_BASE_URL`, `CODERAX_TOKEN`, `CODERAX_TIMEOUT_MS`) | ✅ implemented, tested |
| HTTPS enforcement (HTTP only on loopback) | ✅ implemented, tested |
| `chat` / `work` streaming with SSE parsing | ✅ implemented, tested |
| `products`, `cloud` and `projects` status | ✅ implemented, tested |
| `doctor` diagnostics | ✅ implemented, tested |
| `health` with fallback probes | ✅ implemented, tested |
| `openapi` discovery and operation listing | ✅ implemented, tested |
| `call <METHOD> <PATH> [--data]` | ✅ implemented, tested |
| `agents` / `models` resolved from OpenAPI | ✅ implemented, tested |
| Token redaction in every output path | ✅ implemented, tested |
| File upload, agent mutation | ⛔ not implemented — use `call` |

## Install

```sh
npm link            # exposes `coderax`
# or run directly:
node src/cli.js --help
```

## Configure and sign in

```sh
coderax config set --base-url https://coderax.example.com
coderax login
```

Remote deployments must be HTTPS. `http://localhost`, `127.0.0.1`, and `::1` are
allowed for local development. The config file contains deployment settings only
(URL, timeout, paths); it never contains a token.

Environment variables win over the file:

```sh
export CODERAX_BASE_URL=https://coderax.example.com
# Set CODERAX_TOKEN from a CI secret or read it without echoing it; do not put
# the token itself in a command that your shell records.
read -rs CODERAX_TOKEN && export CODERAX_TOKEN
```

`CODERAX_CREDENTIAL_STORE` may select `auto`, `keychain`, `libsecret`, or `dpapi`
for diagnostics; it cannot turn on an insecure fallback.

When `CODERAX_TOKEN` is set, also set `CODERAX_BASE_URL`. The CLI refuses a
`--base-url` that differs from the token's configured deployment rather than
sending an environment token to an unexpected origin.

## Use

```sh
coderax login
coderax auth status
coderax whoami
coderax status
coderax chat "Summarize this repository"
coderax work "Draft a release checklist"
coderax products
coderax models --json
coderax agents --json
coderax health
coderax openapi
coderax call GET /api/models --json
coderax call POST /api/ask --data '{"text":"hello"}'
coderax logout
```

`openapi`, `agents`, and `models` use the deployment's OpenAPI document. `health`
probes fixed paths, `login` resolves the deployment's auth contract, `doctor`
checks `/api/health`, `chat` and `work` use the configured chat path, and `call`
uses the path you supply. `auth status` reports local credential state without
contacting the deployment; `whoami` performs the remote identity check.

## Session behavior

- JWT `exp` is enforced locally; opaque tokens without expiry metadata receive a
  12-hour local session limit unless the deployment returns `expires_in`.
- A token within 60 seconds of expiry is refreshed before use. A `401` from the
  deployment triggers one refresh-and-retry.
- Refreshes may rotate the refresh token. A response that grants new scopes is
  rejected (`CREDENTIAL_SCOPE_ESCALATION`) until the user signs in again.
- `logout` revokes the refresh and access tokens when the deployment advertises
  revocation, then deletes the local credential. A failed revocation still
  removes the local copy and warns that the server token may remain valid.
- Credentials are bound to the deployment URL and issuer that issued them. A
  token is never sent to a different origin, including via `--base-url`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | other operational failure (missing operation, unavailable health check, other non-2xx HTTP status) |
| `2` | usage error or invalid configuration (bad URL, insecure transport, credential store unavailable, disabled TLS verification) |
| `3` | authentication or authorization failure (no session, expired session, insufficient scope, HTTP 401/403) |
| `4` | network failure or timeout |
| `5` | not found (HTTP 404) |
| `6` | unavailable (Cloud/projects) |
| `130` | cancelled |

Errors print as `coderax: <CODE>: <message>` for typed failures, with every
credential redacted if a server ever echoes one.
