# Coderax CLI

Command-line client for a Coderax deployment. It configures a deployment URL and
token, chats and runs Work mode, lists products, agents and models, checks
health, reads the deployment's own OpenAPI document, and issues authenticated
calls.

This repository is the **canonical** Coderax CLI. The in-repo `Coderax/cli`
package is deprecated; it is replaced by this implementation.

- Repository: `Auctivon-CoderaxAI/Coderax-CLI` (private)
- Runtime: Node.js 24, standard library only, no runtime dependencies
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (deployment)

## Why paths are discovered, not hardcoded

Coderax exposes its API through an OpenAPI document with Swagger UI. This CLI
reads that document and resolves `agents` and `models` from it. If a deployment
does not expose a route, the CLI says so (`OPERATION_NOT_FOUND`) instead of
sending a request to a guessed path. `coderax call` exists for routes outside the
convenience commands.

## Status

| Capability | Status |
| --- | --- |
| `config show` / `config set` with `0600` persistence | ✅ implemented, tested |
| Environment precedence (`CODERAX_BASE_URL`, `CODERAX_TOKEN`, `CODERAX_TIMEOUT_MS`) | ✅ implemented, tested |
| HTTPS enforcement (HTTP only on loopback) | ✅ implemented, tested |
| `login` / `logout` / `status` with token masking | ✅ implemented, tested |
| `chat` / `work` streaming with SSE parsing | ✅ implemented, tested |
| `products`, `cloud` and `projects` status | ✅ implemented, tested |
| `doctor` diagnostics | ✅ implemented, tested |
| `health` with fallback probes | ✅ implemented, tested |
| `openapi` discovery and operation listing | ✅ implemented, tested |
| `call <METHOD> <PATH> [--data]` | ✅ implemented, tested |
| `agents` / `models` resolved from OpenAPI | ✅ implemented, tested |
| Token redaction in every error path | ✅ implemented, tested |
| File upload, agent mutation | ⛔ not implemented — use `call` |

## Install

```sh
npm link            # exposes `coderax`
# or run directly:
node src/cli.js --help
```

## Configure

```sh
coderax config set --base-url https://coderax.example.com --token "<token>"
```

Config is written to `~/.coderax/config.json` with mode `0600` (override with
`CODERAX_CONFIG`). Environment variables win over the file:

```sh
export CODERAX_BASE_URL=https://coderax.example.com
export CODERAX_TOKEN=...
```

Remote deployments must be HTTPS. `http://localhost`, `127.0.0.1`, and `::1` are
allowed for local development.

## Use

```sh
coderax login
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
```

`chat`, `work`, `login`, `status` and `doctor` use the deployment's product API.
`health`, `openapi`, `agents`, `models` and `call` use its OpenAPI document.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational failure (HTTP error, missing operation) |
| `2` | usage or configuration error |
| `3` | unauthenticated |
| `4` | network error |
| `5` | not found |
| `6` | unavailable (Cloud/projects) |
| `130` | cancelled |

Errors print as `coderax: <CODE>: <message>` for typed failures, with the token
redacted if a server ever echoes it.
