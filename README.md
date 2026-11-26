# Coderax CLI

The Coderax terminal client for interactive Chat and Work, durable cloud
engineering tasks, conversation history, approvals, notifications and the
authoritative WorkflowEngine API.

`coderax` is a terminal access and control client. It does not run model
inference, builds, tests, databases, agent workloads or a development server on
your machine. Every turn and every Work task is executed by the configured
Coderax WorkflowEngine in its cloud workspace.

- Repository: `Auctivon-CoderaxAI/CoderaxCLI`
- Runtime: Node.js 24 or newer, standard library only, zero runtime dependencies
- Engine contract: `1.0.0`, event schema `1`, API prefix `/v1`
- Shared SDK: wire-compatible mirror of `@coderax/sdk@1.0.0` / `@coderax/contracts@1.0.0`

## Install

### Release archives (recommended)

Each GitHub release publishes independent Windows, macOS and Linux archives with
a `SHA256SUMS` file. The installers verify the checksum, install under
`~/.coderax` (or `%LOCALAPPDATA%\Coderax`), and do not use npm or require root.

```sh
# Linux or macOS
CODERAX_VERSION=1.0.0 sh install.sh

# Windows PowerShell
$env:CODERAX_VERSION = "1.0.0"; .\install.ps1
```

Add the printed `bin` directory to `PATH`, then run `coderax`.

### From source

```sh
npm ci                 # the lockfile is committed; there are no runtime deps
node src/cli.js --help
npm link               # optional local `coderax` command
```

No package is published to an external registry. `package.json` is private by
design until publication is explicitly authorized.

## Configure

```sh
coderax config set --engine-url https://workflow.example.com
coderax login
```

`login` verifies the owner token against `/v1/health` and `/v1/agents` before
saving it. The token is stored in the operating system credential store:

| Platform | Backend |
| --- | --- |
| macOS | Keychain (`security`) |
| Windows | DPAPI, current-user scope |
| Linux | Secret Service (`secret-tool`) |
| Explicit fallback | Private file, only with `--credential-store file`; `0600` on POSIX, user-profile file on Windows |

`auto` fails closed with `CREDENTIAL_BACKEND_MISSING` when the native helper is
missing. It never silently writes a plaintext token file.

`config.json` never contains the token. `CODERAX_ENGINE_TOKEN` and
`CODERAX_TOKEN` override the store for short-lived CI use; `CODERAX_ENGINE_URL`
overrides the configured URL. Remote URLs must use HTTPS; HTTP is accepted only
for `localhost`, `127.0.0.1` and `::1`.

```sh
coderax status
coderax doctor
coderax engine health
coderax engine ready
coderax engine contract
```

## Interactive terminal

Run `coderax` with no arguments. The prompt starts in Chat mode or the last mode
you used.

- `/mode chat|work`, `/chat [text]`, `/work [text]` switch and submit.
- `/new`, `/sessions`, `/switch <id>` manage conversations.
- `/agent [id]`, `/model [provider/model]` select and persist by default.
- `/tasks`, `/status [id]`, `/report [id]`, `/attach [id]` inspect tasks.
- `/cancel [id]`, `/resume [id]`, `/retry [id]` control a task.
- `/permissions [id]` lists approvals; approval prompts appear inline while a
  task runs.
- `/notifications` reads durable completion notifications; the prompt shows a
  `●N` unread indicator and `coderax status` reports both server and local
  unread counts.
- `/templates` lists the engineering presets.
- `/multiline` toggles blank-line submission; when off, a trailing `\` continues
  the current message.
- Tab completes commands outside a running task. Ctrl+C cancels a running task;
  Ctrl+D detaches it and leaves it running in the engine. `/exit` quits.

Streaming output renders Markdown, fenced code, tables, tool calls, file edits,
step progress and approvals. ANSI styling is disabled automatically when stdout
is not a terminal or with `--no-color`.

## Chat

```sh
coderax chat "Summarize the architecture of this repository"
printf 'Explain the failing test\n' | coderax chat
coderax chat --agent coderax --model provider/model "Continue the review"
```

Chat is a single engine turn. `--conversation <id>` continues an existing
conversation; `--new` starts a new one. The active conversation is recorded in
the local journal so the next command can continue it.

## Work

```sh
coderax work "Inspect the repository and report the three riskiest areas"
coderax work --template implement "Add validation for empty task objectives"
coderax work --detach --template test "Run the focused test suite"
coderax work list
coderax work status <taskId>
coderax work attach <taskId>
coderax work report <taskId>
coderax work cancel <taskId>
coderax work resume <taskId>
coderax work retry <taskId>
coderax work resolve
coderax work uncertain
```

Work is a durable cloud task. Submission is at-most-once: the CLI stores a
client-generated idempotency key before the POST, reuses it for an explicit
retry, and records an ambiguous outcome as `SUBMISSION_UNCERTAIN` instead of
submitting a second task automatically. `coderax work resolve` reconciles an
uncertain submission.

`--detach` prints the task id and returns after the engine accepts the task.
Tasks survive terminal disconnects; reattach with `work attach` or
`work watch --from <seq>`. Cancellation, resume and retry use the engine's
fencing generation and report the engine's actual outcome.

By default a Work task requests approval before a tool needs an owner decision.
The CLI prompts when interactive. Non-interactive runs exit `8` with the task
and request ids, so the decision can be made explicitly:

```sh
coderax permissions list <taskId>
coderax permissions decide <taskId> <requestId> --approve
coderax permissions decide <taskId> <requestId> --deny --reason "out of scope"
coderax work attach <taskId>
```

`--approve-all` and `--deny-all` are explicit non-interactive policies; neither
is a default.

### Engineering workflow presets

| Template | Cloud action |
| --- | --- |
| `inspect` | Reads the cloud workspace and reports structure, tests, CI and risks |
| `implement` | Makes a scoped change and runs the focused check |
| `test` | Runs the repository's test command and reports exact results |
| `diff` | Produces a reviewable working-tree diff with risk notes |
| `pr` | Prepares a branch name, commit message and PR body without pushing |
| `review` | Addresses pasted review findings and verifies each fix |
| `ci` | Reproduces the CI checks in the cloud workspace and reports each step |

These are objectives sent to the engine, not a second workflow engine. Each
requires the selected agent to publish `tools: true`; if the engine reports
`tools: false`, the CLI exits `7` with `CAPABILITY_UNSUPPORTED` and names the
missing capability. It does not simulate a coding run locally.

## Reliability

- Automatic SSE reconnect with bounded exponential backoff.
- Durable replay from the last acknowledged sequence, including
  `Last-Event-ID` and the engine's `after` cursor.
- Per-event deduplication by event id and sequence, plus explicit gap detection.
  A gap is a non-retryable contract error rather than silently missing work.
- Terminal tasks are recovered by fetching authoritative status after an
  interrupted stream.
- Contract negotiation reads the engine's reported `contractVersion`; a
  mismatch exits `7` before Work is submitted.
- Owner-token refresh is attempted once on `401`, using the configured refresh
  command or a newly stored token. A failed refresh exits `3`.
- Unsupported capabilities and unknown HTTP problem codes fail explicitly.
- Idempotent Work submission with a persisted ledger.
- `--json` emits one document; `--ndjson` emits one JSON object per line and a
  final result object. Human progress goes to stderr in machine modes.
- Stable exit codes.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational failure |
| `2` | usage or configuration error |
| `3` | authentication or authorization failure |
| `4` | network failure or timeout |
| `5` | not found |
| `6` | unavailable / not ready |
| `7` | contract or capability unsupported |
| `8` | owner approval required |
| `9` | submission uncertain |
| `10` | conflict or busy |
| `130` | cancelled |

Errors are `coderax: <CODE>: <message>`, with the owner token redacted from
every path. JSON errors include `code`, `message`, `exitCode`, `retryable` and,
when supplied by the engine, `requestId`.

## Security

- Owner authentication only. The CLI sends no anonymous request to owner routes;
  `/v1/health` and `/v1/ready` are public by contract.
- Tokens are held in the OS credential store (or an explicitly requested private fallback file), never written to `config.json`,
  logs, machine output or error text.
- Provider API keys are never read by the CLI. Credential refresh helpers run
  with an allowlisted environment, no shell, bounded output and a timeout; the
  owner token is written to stdin, not argv.
- Remote transport is HTTPS; redirects are refused so a bearer token cannot be
  forwarded to another origin.
- Hidden secret input for `login`, and `--token-stdin` for automation.
- `coderax logout` removes the stored token and warns when an environment token
  remains active.

## Contract and shared SDK

The authoritative surface is the WorkflowEngine route catalogue and OpenAPI
document at engine contract `1.0.0`. The CLI's `src/engine/contract.js` is a
strict, dependency-free mirror of the shared contract schemas, including exact
keys, bounds and event envelopes. The engine's `@coderax/sdk` and
`@coderax/contracts` packages are private workspace packages; the mirror keeps
the CLI installable from a source archive while preserving the same wire
version.

The reviewed engine artifact is vendored at
`contracts/workflow-engine-1.0.0.openapi.json` with its commit and SHA-256 in
[`contracts/PROVENANCE.md`](contracts/PROVENANCE.md). The route table and digest
are checked offline by `npm test`; CI additionally checks a live engine
checkout and runs the CLI against the engine's own HTTP harness.

CI checks the mirror against a pinned WorkflowEngine commit and its
`openapi.json`:

```sh
node scripts/check-contract.mjs ../Coderax-WorkflowEngine
```

See [`docs/CONTRACT.md`](docs/CONTRACT.md) for routes, event semantics,
idempotency and the deployment surface.

## Releases and packaging

```sh
npm run check
npm test
npm run test:contract
npm run pack:check
npm run release:build -- --platform linux --arch x64
```

`pack:check` packs the real tarball, installs it into a clean prefix, verifies
the `coderax` bin, checks the dependency tree and rejects test/secrets files.
`release:build` stages the package, creates `.tar.gz` and `.zip` archives, and
writes `SHA256SUMS-<platform>-<arch>` and a manifest.

GitHub Actions runs the suite on Ubuntu, Windows and macOS using standard
GitHub-hosted runners. Tagged releases build archives on each OS and attach them,
`SHA256SUMS` and the installers to a GitHub release. No external registry is
used.

## Development

```sh
npm ci
npm run check          # syntax, ESM boundary, zero-dependency and version checks
npm test               # 180 unit, CLI, contract, integration and interactive tests
                       # (3 real-engine tests skip without a built checkout)
npm run test:contract  # vendored pin and local mirror; add an engine checkout for cross-repo
WORKFLOW_ENGINE_ROOT=../Coderax-WorkflowEngine npm run test:engine
npm run pack:check     # packed entrypoint and dependency integrity
npm run fixture:engine # local contract-faithful engine fixture
```

The test fixture implements the engine's auth, health, agents, models, Chat,
Work, events, approvals, cancel/resume/retry, notifications and conversations
with an in-memory store. It is test-only; the CLI has no local engine mode.

## Current limitations

- A deployed WorkflowEngine URL and an owner token are required for live use.
  Neither is baked into this repository.
- The engine's Native agent reports its real capabilities. When it publishes
  `tools: false`, repository inspection, code changes, tests, diffs, PR
  preparation, review remediation and CI monitoring are refused with
  `CAPABILITY_UNSUPPORTED`; they are not faked locally.
- The `pr` template prepares a PR body but never pushes or opens a pull request.
  The CLI holds no GitHub token.
- The deployment/OpenAPI surface (`coderax deploy ...`, `coderax call`,
  `products`, `cloud`, `projects`) is retained for legacy Coderax deployments
  and is separate from the WorkflowEngine commands.
