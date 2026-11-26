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
| Interactive Chat/Work terminal (markdown, highlighting, multiline editing) | ✅ implemented, tested |
| Keyboard shortcuts, command completion, model/agent and conversation selection | ✅ implemented, tested |
| Prompt history with retention, clearing, disabling and private storage | ✅ implemented, tested |
| Explicit, per-send approval for local file attachments | ✅ implemented, tested |
| Terminal output sanitisation (ANSI, OSC 52, control sequences) | ✅ implemented, tested |
| Server-bound permission approvals | ✅ implemented, fails closed on the legacy transport |
| Canonical `@coderax/sdk` transport | ⛔ gated: legacy is the default until the shared contract is verified |
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

`openapi`, `agents`, and `models` use the deployment's OpenAPI document. `health`
probes fixed paths, `login` checks `/api/user`, `doctor` checks `/api/health`,
`chat` and `work` use the configured chat path, and `call` uses the path you
supply.

## Interactive terminal

Run `coderax chat` or `coderax work` with no prompt in a real terminal (or pass
`--interactive`) to open the interactive session:

```sh
coderax chat
coderax work --interactive --model gpt-4.1 --agent reviewer
coderax chat --resume <conversation-id>
```

Responses stream as markdown with syntax-highlighted code, tool activity,
progress and permission requests. The session keeps only a bounded tail of the
last response; long answers and long sessions do not grow terminal memory
without limit.

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt |
| `Ctrl+J` / `Alt+Enter` | Insert a newline |
| `Tab` | Complete a slash command or selection value |
| `Up` / `Down` | Prompt history (or move between input lines) |
| `Ctrl+A` / `Ctrl+E` | Start / end of line |
| `Ctrl+W` | Delete the previous word |
| `Ctrl+K` / `Ctrl+U` | Kill to end / start of line |
| `Ctrl+L` | Redraw the screen |
| `Esc` / `Ctrl+C` | Cancel a streaming response (or clear input) |
| `Ctrl+D` | Exit on an empty prompt |

Commands: `/help`, `/mode`, `/model`, `/agent`, `/resume`, `/retry`, `/cancel`,
`/clear`, `/new`, `/history`, `/permissions`, `/status`, `/quit`.

`--accessible` uses a line-oriented input mode with numbered choices instead of
cursor addressing, for screen readers and minimal terminals. `NO_COLOR` and
`--no-color` disable colour; `TERM=dumb` is respected.

### Privacy

Prompt history is stored beside the config (`history.json`) with platform ACL
verification, never includes responses, and skips prompts that look like secrets
or reference local files. Retention, clearing and disabling are available in
the session and from the CLI:

```sh
coderax history list
coderax history retention 7
coderax history off       # also removes conversation metadata
coderax history clear
coderax history on
```

`--no-history` disables reading and writing for one run. Local files referenced
with `@path` are never read automatically: each file is shown with its exact
path, size and hash and must be approved for that one send. Symlinks are refused
unless explicitly enabled, sensitive paths are always refused, and nothing is
sent without approval.

### SDK transport

The terminal talks to a small facade. The legacy SSE transport is the default;
`CODERAX_SDK=canonical` requires a verified `@coderax/sdk` contract and fails
closed if it is unavailable. `CODERAX_SDK=auto` uses the canonical SDK only
after its contract handshake succeeds and otherwise keeps the legacy transport.
See [docs/TERMINAL.md](docs/TERMINAL.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | other operational failure (missing operation, unavailable health check, other non-2xx HTTP status) |
| `2` | usage error or invalid configuration (bad URL, insecure transport, bad timeout) |
| `3` | authentication or authorization failure (HTTP 401/403) |
| `4` | network failure or timeout |
| `5` | not found (HTTP 404) |
| `6` | unavailable (Cloud/projects) |
| `130` | cancelled |

Errors print as `coderax: <CODE>: <message>` for typed failures, with the token
redacted if a server ever echoes it.
