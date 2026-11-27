# Coderax CLI

Owner-only command-line client for a cloud-hosted Coderax deployment. It
configures a deployment URL, authenticates as the instance owner, chats and runs
Work, submits autonomous builds, monitors durable runs, lists products, agents,
models and repositories, checks health, reads the deployment's own OpenAPI
document, and issues authenticated calls.

The CLI does not run models, agents, containers, or databases locally. Inference
and state live in the Coderax deployment; this program makes HTTP requests and
exits. Installing it never pulls in Ollama, Docker, a local AI runtime, a
database, or a background service.

- Repository: [`Auctivon-CoderaxAI/CoderaxCLI`](https://github.com/Auctivon-CoderaxAI/CoderaxCLI) (public)
- Runtime: Node.js 24 or newer, the pinned capability SDK and its schema validator
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (deployment)
- Distribution: GitHub Releases (canonical); npm-ready but not published
- Shared contract: [`packages/workflow-sdk`](packages/workflow-sdk/src/contract.js)

This repository is the **canonical** Coderax CLI. The in-repo `Coderax/cli`
package is deprecated; it is replaced by this implementation.

## Install

| Method | Command | Notes |
| --- | --- | --- |
| Linux / macOS | `sh install.sh --version 0.3.0` | Verifies SHA-256, installs atomically to `~/.coderax/cli/0.3.0` |
| Windows | `powershell -File install.ps1 -Version 0.3.0` | Installs atomically to `%LOCALAPPDATA%\Coderax\cli\0.3.0` |
| npm tarball | `npm install --global ./coderax-cli-0.3.0.tgz` | Works today; registry publication is not enabled |
| Source | `npm ci --ignore-scripts && node src/cli.js --help` | For development |

Release downloads are public. Full instructions, checksum and provenance
verification, offline installs and PATH setup: [docs/INSTALL.md](docs/INSTALL.md).

## Authenticate

A token is a secret, not a configuration value. It is refused as a command-line
argument because argv is visible in shell history and process listings:

```sh
coderax login
printf '%s' "$TOKEN" | coderax login
coderax login --token-file ~/.coderax/token
```

Interactive login prompts at a terminal with echo disabled. Piped input is
supported for CI environments. Token files must have restricted permissions
(`0600` on POSIX systems).

`CODERAX_TOKEN` is also read for CI. `coderax login --token ...` exits `2` with
an explanation.

Login stores the token in Windows DPAPI, Linux Secret Service, or macOS
Keychain. It fails if the credential store is unavailable. Set
`CODERAX_TOKEN` for automation that does not need to save a credential.
Use `CODERAX_SDK=workflow coderax login` for a legacy owner endpoint or
`coderax v1 login` for a deployment that exposes the explicit v1 contract.

See [SECURITY.md](SECURITY.md).

```sh
coderax status
coderax whoami
coderax doctor
coderax compat
coderax chat "Summarize this repository"
```

Requirements: Node.js 24 or newer, HTTPS access to your deployment, and nothing
else. No administrator rights, services, daemons, or open ports.

## Status

| Capability | Status |
| --- | --- |
| `config show` / `config set` with `0600` persistence | ✅ implemented, tested |
| Environment precedence (`CODERAX_BASE_URL`, `CODERAX_TOKEN`, `CODERAX_TIMEOUT_MS`) | ✅ implemented, tested |
| HTTPS enforcement (HTTP only on loopback) | ✅ implemented, tested |
| `login` with owner-role verification and secure secret input | ✅ implemented, tested |
| OS credential storage (Windows DPAPI, Linux Secret Service) | ✅ implemented, tested with an injected helper |
| `chat` / `work` streaming with SSE parsing and redaction | ✅ implemented, tested |
| Autonomous Work submission, durable runs, resume/retry/cancel | ✅ implemented, contract-tested |
| `tasks`, `workflows`, `runs`, `approve`, `repos`, `whoami` | ✅ implemented, contract-tested |
| `login` / `logout` / `status` with token masking | ✅ implemented, tested |
| Interactive Chat/Work terminal (markdown, highlighting, multiline editing) | ✅ implemented, tested |
| Keyboard shortcuts, command completion, model/agent and conversation selection | ✅ implemented, tested |
| Prompt history with retention, clearing, disabling and private storage | ✅ implemented, tested |
| Explicit, per-send approval for local file attachments | ✅ implemented, tested |
| Terminal output sanitisation (ANSI, OSC 52, control sequences) | ✅ implemented, tested |
| Server-bound permission approvals | ✅ implemented, fails closed on the legacy transport |
| Shared workflow SDK transport | ✅ default for the legacy deployment contract (`packages/workflow-sdk`) |
| Canonical WorkflowEngine `/v1` transport | ✅ implemented in the shared SDK; `CODERAX_SDK=v1` selects it and fails closed |
| Artifact upload/download | ⛔ not in contract 1.0.0; `/v1` publishes no transfer route |
| Scheduled task management | ⛔ not in contract 1.0.0; `/v1` publishes no schedule route |
| `products`, `cloud` and `projects` status | ✅ implemented, tested |
| `doctor` diagnostics, `version`, `compat`, `uninstall` | ✅ implemented, tested |
| Reproducible artifacts, SHA-256 checksums, SPDX SBOM | ✅ implemented, verified |
| Traversal/symlink/overwrite-safe archive extraction | ✅ implemented, tested |
| Atomic upgrade with retained rollback directory | ✅ implemented, tested |
| Cross-platform installation tests | ✅ Linux executed; macOS/Windows in hosted CI |
| Release provenance verification (`--provenance`) | ✅ verifies Sigstore bundles or legacy GitHub attestations |
| npm registry publication | ⛔ not enabled — owner authorization required |
| Automatic updates | ⛔ deliberately not implemented |
| File upload, agent mutation | ⛔ not implemented — use `call` where supported by the backend |

## Compatibility

Two independent signals decide compatibility, because the CLI speaks an API
contract and runs against a deployment release:

| Signal | Source | Supported |
| --- | --- | --- |
| API version | `x-coderax-api-version` handshake from `packages/workflow-sdk` | `1.x` |
| Deployment version | OpenAPI `info.version` | `>=0.8.8 <1.0.0` |

`coderax compat` reports each axis separately and treats unknown as unknown,
never as compatible. The previous `>=0.8.0 <1.0.0` "WorkflowEngine" range was a
guess: the reference deployment reports `v0.8.8`, its `/health` endpoint
returns plain text with no version, and the separate
`Coderax-WorkflowEngine` package is `0.1.0`.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## How availability is decided

The engine publishes `GET /v1/handshake`: contract version, event schema,
minimum SDK, the state of every capability it knows about, and the exact
operations it implements. That document is authoritative; there is no separate
capability-registry route and no client-side list of "supported" features.

```sh
coderax capabilities              # status for every capability family
coderax readiness                 # health, readiness, owner check, counts
```

Each family is reported as one of:

| Status | Meaning |
| --- | --- |
| `available` | own capability, every prerequisite and every required operation are available |
| `unconfigured` | the engine knows the capability but is not configured to run it |
| `unverified` | the contract is incompatible, an operation is missing, or the state is not one the CLI can trust |
| `unavailable` | the engine reports the capability as unsupported |
| `blocked` | the family is fine but a prerequisite is unsupported or unconfigured (the key is named) |
| `not_implemented` | the engine publishes no operation for a dedicated backend (for example Native Game Studio) |

Only `available` executes. A refusal names the prerequisite and exits `6`;
nothing is simulated locally. Because the check is derived from the live
handshake, a capability implemented on an unmerged engine branch is reported
`not_implemented`, and the same capability becomes `available` automatically
once a deployment publishes its operations.

## Capabilities

```sh
# discovery
coderax capabilities --json
coderax readiness --json

# creation and analysis (all executed as cloud Work tasks)
coderax create-document "Release notes for 0.3" --format md --out notes.md
coderax analyze-document report.pdf --question "What changed?"
coderax create-pdf "One-page summary of the design" --name summary
coderax analyze-pdf report.pdf --question "Which risk is highest?"
coderax create-spreadsheet "Budget for Q1" --format xlsx
coderax analyze-spreadsheet budget.xlsx --question "Which line grew most?"
coderax create-presentation "Quarterly review" --format pptx
coderax analyze-data "Find the outlier" --file metrics.csv
coderax visualize-data "Revenue by month" --file revenue.csv --chart line
coderax understand-image screenshot.png --question "What is failing?"
coderax generate-image "A paper lighthouse" --size 1024x1024
coderax edit-image photo.png --instruction "Remove the background"
coderax transcribe interview.m4a --format srt
coderax speak "Deployment complete" --format mp3 --out done.mp3
coderax understand-video demo.mp4 --question "What is demonstrated?"
coderax create-software "Add a health endpoint" --name api
coderax create-game "A small puzzle game"          # not_implemented unless the engine publishes games
coderax gaming-agent "Reach level 2" --session s1  # same rule
coderax orchestrate "Coordinate a review and a fix" --agent coderax

# artifacts (task-scoped, owner-authoritative)
coderax artifacts list --task <taskId>
coderax artifacts inspect <artifactId>
coderax artifacts download <artifactId> --out report.pdf

# durable schedules and owner decisions
coderax schedules create "Nightly dependency audit" --at 2026-12-01T02:00:00Z --every 86400000
coderax schedules list
coderax permissions list
coderax permissions approve <taskId> <requestId>

# reattach to a task that outlived the terminal
coderax task <taskId>
```

### How a request runs

1. The CLI negotiates the handshake and refuses an incompatible contract.
2. It resolves the family and refuses anything that is not `available`.
3. It validates the local file (regular file, size, extension/magic agreement,
   accepted MIME) and hashes it **before** anything is sent.
4. It submits one `POST /v1/work` objective with an owner-scoped idempotency key.
5. If a file was supplied, it stores the bytes on the accepted task with
   `POST /v1/work/{taskId}/artifacts` and verifies the digest the engine returns.
   If that upload fails or mismatches, the task is cancelled rather than left
   running without its input.
6. It follows `GET /v1/work/{taskId}/events` from the last applied sequence,
   falling back to polling only when the deployment does not publish the stream.
7. It reads `GET /v1/work/{taskId}/artifacts`, and downloads only with `--out`,
   verifying the published `sha256:<hex>` and byte count before the file appears.

The wait limit (`--wait-timeout`, default 10 minutes) is local. Hitting it exits
`4` with the authoritative state and **does not** cancel the task; cancellation
is explicit (`coderax cancel`, or `--no-wait` and a later decision). A failed,
cancelled or interrupted task exits `1`.

## Artifacts and cross-client continuity

Artifacts are records of the engine's task-scoped artifact service, owned by the
owner and addressed by the task that produced or received them. The CLI reads
and writes that same store, so an artifact created through CoderaxCLI is visible
to Coderax Web under the same owner when both clients use the same task, and the
reverse. The CLI keeps no local artifact catalog. PR #7 keeps these records in
process memory; durable storage is a separate engine branch awaiting merge.

- Uploads are base64 inside the published `ArtifactCreateRequest`; paths are
  relative, traversal-free and drive-letter-free.
- Downloads require a published digest. A mismatch is an integrity failure
  (`ARTIFACT_INTEGRITY_FAILED`) and no file is written.
- An existing destination is never replaced without `--force`.
- A directory, missing parent or symbolic-link destination is refused.

## Use

```sh
coderax chat "Summarize this repository"
coderax work "Draft a release checklist"
coderax work submit "Fix the failing test" --repo owner/name --agent <id>
coderax tasks
coderax workflows
coderax runs --workflow <id>
coderax run <runId> --no-follow
coderax products
coderax models --json
coderax agents --work --json
coderax health
coderax openapi
coderax call GET /api/models --json
```

`openapi`, `agents`, and `models` use the deployment's OpenAPI document.
`call` uses the path you supply.

A missing discovered route fails with `OPERATION_NOT_FOUND`; a missing
backend capability fails closed with `CAPABILITY_UNAVAILABLE`.

## Contract behavior and limitations

| Situation | CLI behaviour |
| --- | --- |
| No API version in metadata or response headers during negotiation | `API_VERSION_UNVERIFIED`; `--strict` exits `6` |
| Chat stream has no IDs | `CURSOR_UNSUPPORTED`; POST is not retried |
| Run stream replays seen IDs | `CURSOR_IGNORED`; snapshots stay idempotent |
| No `/api/repos` | `CAPABILITY_UNAVAILABLE` (exit `6`); pass `--repo` to `work submit` |
| No `/api/workflows` | Durable commands exit `6`; chat is unaffected |
| No `/api/user` | `OWNER_UNVERIFIABLE`; nothing is stored |
| JSON `200` on an SSE route | `CONTRACT_VIOLATION` (exit `7`) |

See [`docs/CONTRACT.md`](docs/CONTRACT.md) for the exact routes, frame shapes
and reconnection rules, and [`BACKEND-DEFECTS.md`](BACKEND-DEFECTS.md) for the
changes requested from the WorkflowEngine owners.

## Upgrade, rollback, uninstall

```sh
coderax update
coderax version --json
coderax uninstall --dry-run
coderax uninstall --yes
```

- `coderax update` prints upgrade commands and never installs anything
  automatically.
- `coderax version --json` reports what is installed and how.
- `coderax uninstall --dry-run` reports which user data would be removed.
- `coderax uninstall --yes` removes user data; the program remains installed.

Standalone upgrades are staged and committed with a rename. A failed swap
restores the previous version, and `--force` keeps the replaced directory at
`<prefix>/.rollback-<version>-<timestamp>-<pid>`.

- Upgrade procedures: [docs/UPGRADE.md](docs/UPGRADE.md)
- Rollback procedures: [docs/ROLLBACK.md](docs/ROLLBACK.md)
- Uninstallation: [docs/RELEASE.md](docs/RELEASE.md)

## Releases

Every release publishes a GitHub Release with an npm tarball, a POSIX standalone
tarball, a Windows zip, `SHA256SUMS`, a release manifest, and an SPDX SBOM.

Builds are reproducible: fixed metadata, sorted entries, fixed compression and a
fixed `SOURCE_DATE_EPOCH`; `npm run repro` rebuilds twice and compares hashes.

The installers verify checksums by default, extract with a safe extractor
(no absolute paths, `..`, symlinks, duplicates or overwrites), and can verify
release signatures with `--provenance` when the release publishes a Sigstore bundle or a legacy GitHub attestation.

Maintainer documentation: [docs/RELEASE.md](docs/RELEASE.md).

Supported runtimes and deployment versions:
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

```sh
npm run release:check
```

The release check includes syntax validation, tests, build verification,
reproducibility checks and installation tests.

The `coderax interactive` command opens the 1.1 capability terminal. The following
options open the terminal for the legacy or explicit v1 transport.

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

The terminal talks to one facade. `CODERAX_SDK=v1` selects the authoritative
WorkflowEngine `/v1` transport in `packages/workflow-sdk/src/v1`; it verifies
the contract, streams with `Last-Event-ID`/`after`, deduplicates by `eventId`,
detects sequence gaps, reconnects with a bounded budget, and submits Work
at-most-once from a durable ledger. There is no silent fallback: a deployment
that does not serve `/v1` fails with a contract error.

The legacy deployment contract is an explicit migration mode:
`CODERAX_SDK=workflow` (the default for existing installations) or
`CODERAX_SDK=legacy` (the compatibility SSE adapter). `CODERAX_SDK=canonical`
requires a verified `@coderax/sdk` contract and `CODERAX_SDK=auto` uses that SDK
only after its own handshake succeeds.

For a `/v1`-only deployment, authenticate without the legacy `/api/user` route:

```sh
CODERAX_SDK=v1 coderax v1 login --token-file ~/.coderax/token
coderax v1 whoami
coderax v1 chat "Summarize this repository" --agent coderax
coderax v1 submit "Inspect the repository" --template inspect --agent coderax
```

See [docs/TERMINAL.md](docs/TERMINAL.md) and [docs/CONTRACT.md](docs/CONTRACT.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational failure, missing operation, incompatible/unknown deployment |
| `2` | usage error or invalid configuration (including a token in argv) |
| `3` | authentication or authorization failure |
| `4` | network failure or timeout |
| `5` | not found |
| `6` | unavailable (backend capability/API version, Cloud, projects) |
| `7` | contract violation (including incomplete streams) |
| `8` | approval required and not granted |
| `9` | submission uncertain; do not blindly resubmit |
| `10` | conflict or busy |
| `130` | cancelled |

Errors print as `coderax: <CODE>: <message>` for typed failures, with the token
redacted if a server ever echoes it.

## Development

All development, builds, automated tests and engineering workloads must
execute in authorized cloud environments with zero additional spending.

The owner's personal computer is used only for lightweight CLI access,
authentication and control of cloud-hosted workloads.

The following development commands are intended for a cloud workspace:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run verify:contract
npm run verify:isolation
npm run build
npm run verify
npm run install-test
npm run repro
```

| Command | Purpose |
| --- | --- |
| `npm ci --ignore-scripts` | Install the locked dependency tree |
| `npm test` | Unit, CLI, contract, release and redaction tests |
| `npm run check` | Syntax check for every module |
| `npm run verify:contract` | Fail on a stale SDK version or an operation the deployment does not publish |
| `npm run verify:isolation` | Fail if the CLI gains local inference, a database, a daemon, Docker or Ollama |
| `npm run build` | Generate deterministic artifacts in `dist/` |
| `npm run verify` | Verify checksums, archive contents and extractor integrity |
| `npm run install-test` | Verify installation, authentication, compatibility, upgrade and uninstall |
| `npm run repro` | Build twice and verify identical hashes |

No local AI inference, Ollama, WSL, local containers, local databases, or
background agent services are required.