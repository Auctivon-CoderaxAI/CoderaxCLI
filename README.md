# Coderax CLI

Command-line client for a Coderax deployment. It configures a deployment URL and
token, chats and runs Work mode, discovers engine capabilities and their real
readiness, uploads validated files, submits cloud analysis and creation work,
lists and downloads artifacts, lists products, agents and models, checks health,
reads the deployment's own OpenAPI document, and issues authenticated calls.

This repository is the **canonical** Coderax CLI. The in-repo `Coderax/cli`
package is deprecated; it is replaced by this implementation.

- Repository: `Auctivon-CoderaxAI/Coderax-CLI` (private)
- Runtime: Node.js 24, standard library only, no runtime dependencies
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (deployment)

## Why paths are discovered, not hardcoded

Coderax exposes its API through an OpenAPI document with Swagger UI. This CLI
reads that document for `openapi`, `agents`, and `models`. If a deployment does
not expose one of those routes, the CLI says so (`OPERATION_NOT_FOUND`) instead
of sending a request to a guessed path. `health` probes fixed paths, `login`
checks `/api/user`, `doctor` checks `/api/health`, `chat` and `work` use the
configured chat path, and `coderax call` uses the path you supply.

Capability commands follow the same rule at a higher level: the engine's
capability registry (`GET /v1/capabilities`) decides which command exists, which
options it accepts and whether it may run. See
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md).

## Capabilities and artifacts

The CLI is a cloud access and control client. It does not parse documents, run
inference, generate artifacts or execute development work on your computer.
Those actions happen in the authorized engine environment; the CLI validates
inputs, submits the request, reports progress, and downloads results only when
you ask it to.

```sh
coderax capabilities              # status for every capability
coderax readiness                 # engine readiness + capability counts
coderax analyze-pdf report.pdf --question "What changed?"
coderax analyze-spreadsheet data.xlsx --question "Which region grew?"
coderax create-presentation "Quarterly review" --format pptx
coderax understand-image screenshot.png --question "What is failing?"
coderax generate-image "A paper lighthouse" --size 1024x1024
coderax transcribe interview.m4a --format srt
coderax speak "Deployment complete" --format mp3 --out done.mp3
coderax create-software "Add a health endpoint" --project proj_123
coderax create-game "A small puzzle game"
coderax artifacts list --project proj_123
coderax artifacts inspect art_123
coderax artifacts download art_123 --out report.pdf
coderax artifacts associate art_123 --project proj_123
```

Every capability is displayed as `available`, `unavailable`, `unconfigured`,
`unverified` or `blocked`. Only `available` executes. An omitted capability is
`blocked`; an unknown status is downgraded to `unverified`. The CLI never
presents an unverified capability as operational and never substitutes a local
implementation for a missing engine route.

Uploads are validated for regular-file status, size, extension/magic agreement,
MIME acceptance and SHA-256 before transfer. Downloads are hash-verified and
never replace an existing file without explicit `--force`. Artifacts are
owner-scoped engine records, so CoderaxCLI and Coderax Web see the same catalog
under the same account, project and conversation.

> **Engine baseline:** WorkflowEngine `main` publishes contract `1.0.0` and
> `@coderax/sdk` `1.0.0`, but no multimodal, upload or artifact operation yet.
> Against that baseline these commands correctly report `blocked`
> (`capability_registry_missing`); they become operational when the engine
> publishes the registry and routes. Nothing is simulated locally.

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
| Token redaction in every output path | ✅ implemented, tested |
| Capability discovery and readiness from the engine registry | ✅ implemented, tested |
| Registry-derived options and fail-closed statuses | ✅ implemented, tested |
| Validated, hashed multipart upload | ✅ implemented, tested |
| Cloud analysis, presentation, image, audio, software and game commands | ✅ implemented, registry-gated |
| Artifact list, inspect, hash-verified download, project association | ✅ implemented, tested |
| Local document, inference, generation or execution work | ⛔ never — the CLI is a cloud client |
| Agent mutation | ⛔ not implemented — use `call` |

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
coderax capabilities --json
coderax readiness
coderax upload ./report.pdf --json
coderax artifacts list --json
coderax call GET /api/models --json
coderax call POST /api/ask --data '{"text":"hello"}'
```

`openapi`, `agents`, and `models` use the deployment's OpenAPI document. `health`
probes fixed paths, `login` checks `/api/user`, `doctor` checks `/api/health`,
`chat` and `work` use the configured chat path, and `call` uses the path you
supply.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | other operational failure (task failure, integrity failure, contract mismatch, other non-2xx HTTP status) |
| `2` | usage error, invalid configuration or local input validation (bad URL, insecure transport, bad timeout, rejected upload, unsafe download destination) |
| `3` | authentication or authorization failure (HTTP 401/403) |
| `4` | network failure or timeout |
| `5` | not found (HTTP 404) |
| `6` | unavailable (capability not available, missing registry, Cloud/projects) |
| `130` | cancelled |

Errors print as `coderax: <CODE>: <message>` for typed failures, with the token
redacted if a server ever echoes it.
