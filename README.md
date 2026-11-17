# Coderax CLI

Command-line client for a Coderax deployment. It configures a deployment URL and
token, checks health, reads the deployment's own OpenAPI document, and issues
authenticated calls — including Agent and Model listing when those routes exist.

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
| `health` with fallback probes | ✅ implemented, tested |
| `openapi` discovery and operation listing | ✅ implemented, tested |
| `call <METHOD> <PATH> [--data]` | ✅ implemented, tested |
| `agents` / `models` resolved from OpenAPI | ✅ implemented, tested |
| Token redaction in every error path | ✅ implemented, tested |
| Streaming chat, file upload, agent mutation | ⛔ not implemented — use `call` |

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
coderax health
coderax openapi
coderax agents --json
coderax models --json
coderax call GET /api/models --json
coderax call POST /api/ask --data '{"text":"hello"}'
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational failure (network, HTTP error, missing operation) |
| `2` | usage or configuration error |

Errors print as `coderax: <CODE>: <message>` for typed failures, with the token
redacted if a server ever echoes it.
