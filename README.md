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
- Runtime: Node.js 24 or newer, standard library only, no runtime dependencies
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

On Windows the token is stored with DPAPI; on Linux with the
Secret Service when `secret-tool` is available; otherwise it goes into the
`0600` config file. macOS uses the `0600` file because the Keychain command-line
tool has no interface that accepts a secret without putting it in argv.

The file-based credential fallback is a current implementation limitation
and is not equivalent to encrypted operating-system credential storage.

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

## WorkflowEngine task tools

Use `coderax engine --help` for direct WorkflowEngine commands. This command
group uses the configured deployment and owner credential. For example:

```sh
coderax engine login --token-file /path/to/private-token-file
coderax engine chat "Summarize the release" --json
coderax engine work "Prepare the release checklist" --detach --json
coderax engine events <taskId> --after 0
coderax engine task <taskId> --json
```

A detached Work task keeps running on the engine. Reconnect with `events --after`
or query its final status with `task`. Supplying `--after` when submitting Work
requires following the stream in that invocation, so it cannot be combined
with `--detach`. Chat returns one JSON reply; Work streams task events.
The existing top level commands and the shared SDK's `coderax v1` commands
retain their deployment behavior.

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