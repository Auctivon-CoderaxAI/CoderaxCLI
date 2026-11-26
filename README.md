# Coderax CLI

Owner-only command-line client for a Coderax deployment. It is a thin
authenticated cloud client: interactive Chat, autonomous Work, agent and model
selection, streaming output, durable run monitoring, approvals, cancellation,
resume/retry, diagnostics and secure credential storage. All execution stays in
the deployment; the CLI ships no local inference, database, Docker workload or
agent process.

- Repository: `Auctivon-CoderaxAI/CoderaxCLI` (branch: `main`)
- Runtime: Node.js 24+, standard library only, zero runtime dependencies
- Shared contract: `packages/workflow-sdk` (imported directly; not published)
- Backend: [`Auctivon-CoderaxAI/Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax)
- Backend gaps: [`BACKEND-DEFECTS.md`](BACKEND-DEFECTS.md)
- Wire contract: [`docs/CONTRACT.md`](docs/CONTRACT.md)

## Install (Windows, Linux, macOS)

Requires Node.js 24 or newer.

```sh
npm install -g .          # installs the `coderax` command
# or, without a global install:
npm link
node src/cli.js --help
```

The package has no install scripts, native modules or platform-specific paths.
`npm pack` + install is covered by `npm run smoke:install` on each OS in CI.
On Windows, use PowerShell or Git Bash; no `sudo` is required for a user-local
prefix.

## Sign in as the owner

```sh
coderax config set --base-url https://coderax.example.com
coderax login                 # prompts for the token on stdin
coderax whoami                # verifies role === ADMIN
```

`login` calls `/api/user` and **stores nothing** unless the deployment reports
`role: "ADMIN"`. The token is written to `~/.coderax/config.json` with mode
`0600` (directory `0700`), through a fresh temporary file and an atomic rename.
A symlinked config path is refused. Environment variables override the file:

```sh
export CODERAX_BASE_URL=https://coderax.example.com
export CODERAX_TOKEN=...      # useful in CI; never written to disk
```

Remote deployments must use HTTPS. Plain HTTP is accepted only for loopback
(`localhost`, `127.0.0.1`, `::1`). Redirects are refused so a token cannot be
forwarded to another origin.

## Commands

| Command | Purpose |
| --- | --- |
| `coderax login` / `logout` / `whoami` / `status` | owner-only authentication and account state |
| `coderax chat [message] [--agent <id>] [--model <id>] [--conversation <id>] [--new]` | interactive Chat with streaming output |
| `coderax work [message]` | streaming Work-mode turn |
| `coderax work submit <prompt> --repo <owner/name> --agent <id> [--base-ref <ref>] [--mode turbo15\|autonomous\|verified] [--workspace <name>] [--follow]` | autonomous cloud coding run |
| `coderax tasks [taskId]` | durable Work conversations and their resolved state |
| `coderax workflows` | workflows visible to the owner |
| `coderax runs --workflow <id>` | runs for one workflow (the backend has no global run list) |
| `coderax run <runId> [--no-follow] [--approval ask\|allow\|deny] [--notify] [--notify-command <cmd>] [--cancel-on-interrupt]` | monitor, approve, detach, notify |
| `coderax cancel <runId\|taskId> [--task]` | cancel a run, or a durable Work task |
| `coderax resume <runId>` / `coderax retry <runId>` | resume a paused run or start a fresh run from a failed/completed one |
| `coderax approve <runId> <stepIndex>` | explicit approval |
| `coderax repos` | connected repositories when the deployment advertises them |
| `coderax agents --work` / `coderax models --work` | Work-eligible agents and models |
| `coderax doctor` / `diagnostics` | configuration, auth, connectivity and dependency checks |
| `coderax config show` / `get` / `set` | inspect or change deployment settings |

`chat` and interactive `work` keep conversation continuity per deployment in
the config (`--new` resets it, `--conversation <id>` overrides it). JSON output
is a single document; run monitoring emits NDJSON.

### Streaming, reconnection and detachment

- Chat POSTs are **never retried**: a retry would start a second generation.
  An interrupted turn exits `7` with its conversation id.
- Durable run monitoring reconnects with `Last-Event-ID` when the deployment
  supplies event ids, re-reads safe snapshots otherwise, and de-duplicates
  replays.
- Ctrl-C detaches without cancelling; the run continues server-side. Resume
  with `coderax run <runId>`. `--cancel-on-interrupt` opts into cancellation.
- `--notify` rings the terminal bell at a terminal status; `--notify-command`
  runs an operator-supplied command with `{id}` and `{status}`.
- Approval is fail-closed: `ask` needs a TTY and an explicit yes; a
  non-interactive session never auto-approves.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success (including completed and paused runs) |
| `1` | failed run or other operational failure |
| `2` | usage or configuration error |
| `3` | unauthenticated, forbidden, or not the owner |
| `4` | network failure or timeout |
| `5` | not found |
| `6` | capability or API version unavailable — fail closed |
| `7` | contract violation, including an incomplete stream |
| `130` | cancelled or detached locally |

## Backend dependencies and fail-closed behaviour

The reference deployment publishes no API-version document, no SSE event ids,
no global run index and no repository inventory. The CLI names these gaps
instead of inventing routes:

| Situation | CLI behaviour |
| --- | --- |
| no API metadata | `API_VERSION_UNVERIFIED`; `--strict` exits `6` |
| chat stream has no ids | `CURSOR_UNSUPPORTED`; POST is not retried |
| run stream replays seen ids | `CURSOR_IGNORED`; snapshots stay idempotent |
| no `/api/repos` | `CAPABILITY_UNAVAILABLE` (exit `6`); pass `--repo` to `work submit` |
| no `/api/workflows` | durable commands exit `6`; chat is unaffected |
| no `/api/user` | `OWNER_UNVERIFIABLE`; nothing is stored |
| JSON `200` on an SSE route | `CONTRACT_VIOLATION` (exit `7`) |

See [`docs/CONTRACT.md`](docs/CONTRACT.md) for the exact routes, frame shapes
and reconnection rules, and [`BACKEND-DEFECTS.md`](BACKEND-DEFECTS.md) for the
changes requested from the WorkflowEngine owners.

## Development

```sh
npm run check               # node --check over every source file
npm test                    # 114 offline tests, no deployment required
npm run test:contract       # contract + SSE/session suites
npm run smoke:install       # npm pack + install the tarball in a temp prefix
```

The suite uses injected `fetch`, `env`, stdout/stderr and temporary config
files. It never contacts a real deployment and never needs a token.

Cross-surface visibility against a real deployment is read-only and gated:

```sh
CODERAX_VERIFY_BASE_URL=https://... \
CODERAX_VERIFY_TOKEN=... \
CODERAX_VERIFY_TASK_ID=<task seen in the web app> \
npm run verify:cross-surface
```

It exits `6` when the environment or a shared id is missing, and creates no
task, run or spend. See [`SECURITY.md`](SECURITY.md).
