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
| `products`, `cloud` and `projects` status | ✅ implemented, tested |
| `doctor` diagnostics, `version`, `compat`, `uninstall` | ✅ implemented, tested |
| Reproducible artifacts, SHA-256 checksums, SPDX SBOM | ✅ implemented, verified |
| Traversal/symlink/overwrite-safe archive extraction | ✅ implemented, tested |
| Atomic upgrade with retained rollback directory | ✅ implemented, tested |
| Cross-platform installation tests | ✅ Linux executed; macOS/Windows in hosted CI |
| Release provenance verification (`--provenance`) | ✅ installer support; attestations must be published per release |
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
build provenance with `--provenance` when the release publishes attestations.

Maintainer documentation: [docs/RELEASE.md](docs/RELEASE.md).

Supported runtimes and deployment versions:
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

```sh
npm run release:check
```

The release check includes syntax validation, tests, build verification,
reproducibility checks and installation tests.

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
| `npm run build` | Generate deterministic artifacts in `dist/` |
| `npm run verify` | Verify checksums, archive contents and extractor integrity |
| `npm run install-test` | Verify installation, authentication, compatibility, upgrade and uninstall |
| `npm run repro` | Build twice and verify identical hashes |

No local AI inference, Ollama, WSL, local containers, local databases, or
background agent services are required.