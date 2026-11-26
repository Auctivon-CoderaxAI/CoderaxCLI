# Coderax CLI

Owner-only terminal client for a Coderax **WorkflowEngine** deployment. It is a
thin cloud access and control client: it sends requests, renders events and
stores only its own connection settings. Model routing, agent orchestration and
persistence stay in the engine.

- Repository: `Auctivon-CoderaxAI/CoderaxCLI`
- Runtime: Node.js 24, standard library only, no runtime dependencies
- Engine contract: `1.0.0`; SDK generation `@coderax/sdk` `1.0.0`; events `v1`
- Companion: [`Coderax-WorkflowEngine`](https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine)

## Capabilities

| Capability | Status | How it works |
| --- | --- | --- |
| Owner-only authentication | ✅ | `login` verifies the token with an owner-only `/v1/agents` call; the token is stored `0600` |
| Chat | ✅ | One `POST /v1/chat` turn with optional conversation, agent, model and data mode |
| Work | ✅ | Durable `POST /v1/work` submission followed by its event stream |
| Real-time streaming | ✅ | Work execution events over SSE, with `text.delta` and `text.replace` |
| Work task discovery | ⚠️ limited | Derived from durable notifications; contract 1.0.0 has no task-list operation |
| Conversation history | ✅ | `/v1/conversations` and `/v1/conversations/{id}` |
| Agent and model selection | ✅ | `--agent`, `--model <provider>/<model>`; paid models are refused by the engine |
| Permission requests and decisions | ✅ | `permissions`, `approve`, `deny`; Work detaches when approval is required |
| Durable event replay | ✅ | `events --after <seq>`; `eventId` and per-task `seq` dedupe |
| Automatic reconnection | ✅ | Reconnects from the last sequence with bounded backoff |
| Cancellation | ✅ | `cancel <taskId> [--reason]`, safe from another device |
| Detachment | ✅ | `work --detach` or Ctrl+C; the engine keeps running the task |
| Retry and resume | ✅ | `retry` on the same engine, `resume` from the last checkpoint |
| Notifications | ✅ | Durable completion notifications and unread count |
| File and artifact transfers | ⛔ not in contract 1.0.0 | Task status exposes artifact **metadata** only; there is no upload/download operation |
| Capability discovery | ✅ | `capabilities` reports engine, agent and model truth, including the transfer gap |
| Engine diagnostics | ✅ | `doctor` checks reachability, contract version, readiness and owner auth |
| Cross-device continuity | ✅ | Conversations, tasks, events and memory are server-owned |

The CLI does **not** plan, route models, run agents, persist tasks or execute
engineering workloads. A detached Work task runs on the engine host, never on
the machine running this client.

## Install

```sh
npm link            # exposes `coderax`
# or run directly:
node src/cli.js --help
```

## Configure

Point the CLI at the engine, then sign in as the sole owner:

```sh
coderax config set --base-url https://coderax-engine.example.com
coderax login --token "<owner-token>"
```

Config is written to `~/.coderax/config.json` with mode `0600` (override with
`CODERAX_CONFIG`). The token is never printed. Environment variables win over
the file:

```sh
export CODERAX_BASE_URL=https://coderax-engine.example.com
export CODERAX_TOKEN=...
```

Remote URLs must be HTTPS. `http://localhost`, `127.0.0.1` and `::1` are allowed
for local development.

## Use

```sh
coderax login
coderax status
coderax health
coderax ready
coderax doctor

coderax chat "Summarize the release" --agent coderax --model free/coderax-small
coderax work "Draft the release checklist"
coderax work "Long task" --detach
coderax task <taskId>
coderax events <taskId> --after 12
coderax cancel <taskId> --reason "owner stopped it"
coderax retry <taskId>
coderax resume <taskId>

coderax permissions <taskId>
coderax approve <taskId> <requestId> --reason "checked"
coderax deny <taskId> <requestId>
coderax notifications
coderax tasks
coderax conversations
coderax conversation <conversationId>
coderax memory --mode private
coderax artifacts <taskId>
coderax capabilities
```

Use `--json` for machine-readable output. `events --json` emits one JSON event
per line (NDJSON) so a consumer can follow the stream; `work --json` emits one
document when the task settles.

Chat is a single response in contract 1.0.0. Work is the streaming surface. If
the engine sends a cumulative snapshot and its incremental text together, the
CLI emits only the unseen suffix (or one replacement when the answer is
rewritten), so the same words are never printed twice.

`events` and `work` reconnect after a dropped connection or an engine restart
from the last seen sequence. Replayed events are deduplicated. A 401/403 is not
retried: an expired token is reported with exit code `3`.

At an approval request, an interactive `work` detaches and prints the exact
`approve`/`deny` commands. The task remains paused on the engine; approving it
from another terminal or another device then `coderax events <taskId>` continues
the stream.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational failure, failed/interrupted task, contract or stream protocol failure |
| `2` | usage error or invalid configuration |
| `3` | authentication or authorization failure (HTTP 401/403) |
| `4` | network failure, timeout or lost event stream |
| `5` | task or conversation not found (HTTP 404) |
| `6` | engine unavailable or not ready |
| `130` | cancelled, or the client detached from a still-running task |

Errors print as `coderax: <CODE>: <message>`; the token is redacted from every
output path.

## Testing

```sh
npm run check     # syntax check every source module
npm test          # unit, parser, HTTP and CLI tests
WORKFLOW_ENGINE_ROOT=../Coderax-WorkflowEngine npm run test:engine
```

`test:engine` starts the real WorkflowEngine HTTP server from its checked-out
test harness and exercises owner auth, Chat, Work, streaming, replay, task
status, notifications, history, cancellation, retry and resume through the CLI.
CI checks out the engine at the pinned commit in `contracts/PROVENANCE.md` and
runs that suite on a free GitHub-hosted runner.

The harness injects a deterministic model gateway. A passing integration run
proves the transport, contract and lifecycle, **not** that a production model
produced the answer.

Unit and HTTP tests run on Ubuntu, Windows and macOS. Event parsing normalises
CRLF and lone CR frames, including a CRLF split across reads; config permissions
are enforced on POSIX and tolerated on Windows.

## Deliberate limits

- **No task list endpoint.** `tasks` is derived from durable notifications;
  active tasks are known by the id returned from `work`.
- **No file transfer endpoint.** `artifacts` lists metadata only. Adding
  transfers requires a versioned engine operation.
- **Durability across an engine restart depends on the engine deployment.** The
  engine currently persists leases in MongoDB and task/conversation state in
  memory; restart survival is an engine property, not something this client can
  create.
- **Chat is not streamed by contract 1.0.0.** The CLI will render SSE frames if
  a compatible engine sends them, but the published handler returns one JSON
  reply.
- The previously reported `feat/engine-thin-client` commit `d12a8b5` was not
  present in any organization repository. This implementation was reconstructed
  against the authoritative SDK, as recorded in `contracts/PROVENANCE.md`.

## Security

See [`SECURITY.md`](SECURITY.md). The token is owner-only, stored `0600`, sent
only as a bearer header, never placed in a URL, and redacted from output. The
client follows no redirects and keeps no cookie jar. It runs no inference and no
engineering workload.
