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
coderax login                 # device authorization; opens the deployment page
coderax whoami                # re-checks the authenticated role === ADMIN
```

`login` starts an RFC 8628 device authorization, prints a verification URL and
one-time code, and waits for approval. It calls `/api/user` and **stores nothing**
unless the deployment authenticates the session and reports `role: "ADMIN"`
(the instance owner). The CLI never accepts a token as a command argument.

Credentials live only in an OS facility:

| Platform | Store |
| --- | --- |
| macOS | Keychain via `/usr/bin/security` (secret on stdin) |
| Linux | Secret Service via `secret-tool` (secret on stdin) |
| Windows | DPAPI, `CurrentUser` scope |

There is **no plaintext fallback**. If no store is available, login fails with
`CREDENTIAL_STORE_UNAVAILABLE`; `auth status` and `doctor` explain how to fix it.
The config file contains deployment settings only and is written atomically with
mode `0600`. `saveConfig` rejects token, refresh-token, password, client-secret
and API-key fields.

For headless deployments and CI, pipe a deployment-issued session token:

```sh
printf '%s' "$CODERAX_SESSION_TOKEN" | coderax login --with-token
```

`--with-token` still requires an OS credential store and still verifies the
owner role before storing anything. On a keyring-less runner, use
`CODERAX_TOKEN` directly instead; it is read from the environment for that
process and never written to disk. A token with an `aud` claim can be pinned
with `CODERAX_AUDIENCE`.

Environment variables override the file:

```sh
export CODERAX_BASE_URL=https://coderax.example.com
export CODERAX_TOKEN=...      # short-lived CI token; never written to disk
export CODERAX_AUDIENCE=coderax-cli   # optional expected audience
```

Remote deployments must use HTTPS. Plain HTTP is accepted only for loopback
(`localhost`, `127.0.0.1`, `::1`). Redirects are refused so a token cannot be
forwarded to another origin. `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused while
credentials are in use.

### Migrating from an older build

Older builds wrote `token` or `accessToken` into `~/.coderax/config.json`. The
CLI never loads those fields as a session. It reports `legacyPlaintextToken` and
migrates the value into the OS store on the next authenticated use, then removes
the plaintext field. If migration cannot complete, it fails closed and leaves the
token in place so the owner is not locked out. Remove `coderax config set
--token` and `coderax login --token` from old runbooks; both are rejected.

## Session behavior

- An expiring credential is refreshed once before use; refresh tokens rotate and
  concurrent commands share one rotation. A response that grants new scopes is
  rejected until the owner signs in again.
- Revocation is attempted for the refresh and access token on logout, then the
  local OS item is deleted. If revocation fails, the local copy is still removed
  and the warning explains that the server token may remain valid until expiry.
- A session is bound to its deployment origin. The first login records the
  issuer; `CODERAX_ISSUER` can pin it and `CODERAX_AUDIENCE` can pin the token
  audience. A token is never sent to a different origin.
- Auth expiry during Chat/Work is surfaced with exit `3`; a started write is never
  retried. Reauthenticate and use the preserved task/run id with `coderax run` or
  `coderax tasks` to recover durable progress.

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
