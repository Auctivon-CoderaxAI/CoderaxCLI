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
reads that document for `openapi`, `agents`, and `models`. If a deployment does
not expose one of those routes, the CLI says so (`OPERATION_NOT_FOUND`) instead
of sending a request to a guessed path. `health` probes fixed paths, `login`
checks `/api/user`, `doctor` checks `/api/health`, `chat` and `work` use the
configured chat path, and `coderax call` uses the path you supply.

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
| Workflow surface (`conversations`, `tasks`, `schedules`, `memory`, `notifications`, `permissions`, `artifacts`, `plugins`, `tools`, `projects`, `whoami`) bound to discovered operations | ✅ implemented, tested against a real HTTP harness |
| `capabilities` report of ready / partial / unavailable commands | ✅ implemented, tested |
| `bash` / `zsh` / `fish` completion generated from the catalog | ✅ implemented, tested |
| Artifact upload (multipart) and secure download (`0600`, no silent overwrite) | ✅ implemented, tested |
| Structured JSON errors on stderr with `--json` | ✅ implemented, tested |
| Dedicated document / spreadsheet / presentation / image / audio / game commands | ⛔ none — those run through `work`, `tools` and `artifacts` only when the deployment publishes them |

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

# Workflow surface — each command binds to an operation the deployment publishes
coderax capabilities
coderax conversations --json
coderax tasks --status running
coderax tasks cancel task-1 --yes
coderax resume task-1
coderax retry task-1
coderax detach task-1
coderax schedules create --cron "0 9 * * 1-5" --prompt "Review open pull requests"
coderax schedules pause sched-1
coderax schedules resume sched-1
coderax schedules cancel sched-1 --yes
coderax artifacts upload ./report.pdf --json
coderax artifacts download art-1 --output ./report.pdf
coderax whoami --json

# Shell completion
coderax completion bash > /etc/bash_completion.d/coderax
coderax completion zsh  > "${fpath[1]}/_coderax"
coderax completion fish > ~/.config/fish/completions/coderax.fish
```

### Workflow commands and capability binding

`src/capability-catalog.js` is the canonical command catalog. It declares each
command's *intent* and the contract shape it needs; the concrete method, path
template, path/query parameters, request-body schema and enums come from the
deployment's own OpenAPI document at runtime. `coderax capabilities` prints the
resulting map, for example:

```
CAPABILITY     STATUS       COMMANDS
schedules      ready        list, show, create, update, pause, resume, delete, cancel
conversations  ready        list, show
```

When the document publishes no matching operation, the command exits `1` with
`OPERATION_NOT_FOUND` and sends nothing. Ambiguous matches exit `1` with
`OPERATION_AMBIGUOUS` and ask for `--operation <operationId>`. There are no
stubbed commands and no guessed endpoints.

Workflow commands accept `--json` (envelope `{command, capability, operation,
status, data, meta?}`, with errors as JSON on stderr), `--limit`, `--cursor`,
`--query`, `--status`, repeatable `--param key=value`, and `--operation` to bind
one invocation to a specific operation. Destructive commands require `--yes`.

### Advanced work

Repository inspection, debugging, architecture analysis, code review, PR
preparation and CI monitoring run through `coderax work` (and `coderax chat`),
which stream the deployment's Work engine. They are not separate endpoints:

```sh
coderax work "Review the diff on this branch for correctness risks"
coderax work "Inspect CI failures on the release branch and propose fixes"
coderax work "Prepare a pull request summary for the last three commits"
```

Document, spreadsheet, presentation, image, audio and game creation are likewise
not invented: they are reachable only when the deployment publishes matching
`tools` or `artifacts` operations, which this CLI can list and invoke.

### Same data as Coderax Web

Every workflow command is a thin call to the deployment that also serves Coderax
Web. The CLI keeps no local cache of conversations, tasks, schedules, memory,
notifications, permissions or artifacts, so both clients read and write the same
server-side state.

`openapi`, `agents`, and `models` use the deployment's OpenAPI document. `health`
probes fixed paths, `login` checks `/api/user`, `doctor` checks `/api/health`,
`chat` and `work` use the configured chat path, and `call` uses the path you
supply.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | other operational failure (missing operation, unavailable health check, other non-2xx HTTP status) |
| `2` | usage error or invalid configuration (bad URL, insecure transport, bad timeout) |
| `3` | authentication or authorization failure (HTTP 401/403) |
| `4` | network failure or timeout |
| `5` | not found (HTTP 404) |
| `6` | unavailable (Cloud/projects fallback) |
| `130` | cancelled |

Missing credentials for a command that needs them exit `3` (`UNAUTHENTICATED`).
Destructive workflow commands without `--yes` exit `2` (`CONFIRMATION_REQUIRED`).

Errors print as `coderax: <CODE>: <message>` for typed failures, with the token
redacted if a server ever echoes it. With `--json`, errors are a single JSON
object on stderr: `{"error":{"code","message","status"?,"command"?}}`.
