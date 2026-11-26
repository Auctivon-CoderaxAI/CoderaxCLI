# Coderax CLI

Command-line **access and control interface** for a cloud-hosted Coderax
deployment. It configures a deployment URL and token, chats and runs Work mode,
lists products, agents and models, checks health, reads the deployment's own
OpenAPI document, and issues authenticated calls.

The CLI does not run models, agents, containers, or databases locally. Inference
and state live in the Coderax deployment; this program makes HTTP requests and
exits. Installing it never pulls in Ollama, Docker, a local AI runtime, a
database, or a background service.

- Repository: `Auctivon-CoderaxAI/CoderaxCLI` (private)
- Runtime: Node.js 24 or newer, standard library only, no runtime dependencies
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (deployment)
- Distribution: GitHub Releases (canonical); npm-ready but not published

This repository is the **canonical** Coderax CLI. The in-repo `Coderax/cli`
package is deprecated; it is replaced by this implementation.

## Install

| Method | Command | Notes |
| --- | --- | --- |
| Linux / macOS | `sh install.sh --version 0.2.0` | Verifies SHA-256, installs to `~/.coderax/cli/0.2.0` |
| Windows | `powershell -File install.ps1 -Version 0.2.0` | Installs to `%LOCALAPPDATA%\Coderax\cli\0.2.0` |
| npm tarball | `npm install --global ./coderax-cli-0.2.0.tgz` | Works today; registry publication is not enabled |
| Source | `npm ci --ignore-scripts && node src/cli.js --help` | For development |

Full instructions, checksum verification, offline installs and PATH setup:
[docs/INSTALL.md](docs/INSTALL.md).

```sh
coderax config set --base-url https://coderax.example.com --token "<token>"
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
| `login` / `logout` / `status` with token masking | ✅ implemented, tested |
| `chat` / `work` streaming with SSE parsing | ✅ implemented, tested |
| `products`, `cloud` and `projects` status | ✅ implemented, tested |
| `doctor` diagnostics | ✅ implemented, tested |
| `health` with fallback probes | ✅ implemented, tested |
| `openapi` discovery and operation listing | ✅ implemented, tested |
| `call <METHOD> <PATH> [--data]` | ✅ implemented, tested |
| `agents` / `models` resolved from OpenAPI | ✅ implemented, tested |
| Token redaction in every output path | ✅ implemented, tested |
| Reproducible artifacts, SHA-256 checksums, SPDX SBOM | ✅ implemented, verified |
| Cross-platform installation tests | ✅ Linux verified; macOS/Windows in CI |
| `version` diagnostics, `compat`, `uninstall` | ✅ implemented, tested |
| Shell completion (bash, zsh, fish, PowerShell) | ✅ implemented, tested |
| npm registry publication | ⛔ not enabled — owner authorization required |
| Automatic updates | ⛔ deliberately not implemented |
| File upload, agent mutation | ⛔ not implemented — use `call` |

## Why paths are discovered, not hardcoded

Coderax exposes its API through an OpenAPI document with Swagger UI. This CLI
reads that document for `openapi`, `agents`, and `models`. If a deployment does
not expose one of those routes, the CLI says so (`OPERATION_NOT_FOUND`) instead
of sending a request to a guessed path. `health` probes fixed paths, `login`
checks `/api/user`, `doctor` checks `/api/health`, `chat` and `work` use the
configured chat path, and `coderax call` uses the path you supply.

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
coderax version --json
coderax compat
coderax chat "Summarize this repository"
coderax work "Draft a release checklist"
coderax products
coderax models --json
coderax agents --json
coderax health
coderax openapi
coderax call GET /api/models --json
coderax call POST /api/ask --data '{"text":"hello"}'
coderax update
coderax completion bash        # print a completion script for your shell
```

`openapi`, `agents`, and `models` use the deployment's OpenAPI document. `health`
probes fixed paths, `login` checks `/api/user`, `doctor` checks `/api/health`,
`chat` and `work` use the configured chat path, and `call` uses the path you
supply.

`coderax version --json` reports the CLI version, Node runtime, platform,
install method, install path, and the supported WorkflowEngine range.
`coderax compat` compares the deployment's reported engine version with that
range. Neither command changes anything.

## Upgrade, rollback, uninstall

```sh
coderax update                 # prints upgrade commands; never installs anything
coderax version --json         # what is installed, and how
coderax uninstall --dry-run    # what user data would be removed
coderax uninstall --yes        # remove user data (the program stays)
```

- Upgrade procedures: [docs/UPGRADE.md](docs/UPGRADE.md)
- Rollback procedures: [docs/ROLLBACK.md](docs/ROLLBACK.md)
- Uninstallation and cleanup: [docs/INSTALL.md](docs/INSTALL.md) and
  [docs/RELEASE.md](docs/RELEASE.md)

Standalone installs keep every version side by side, so a rollback is normally
`ln -sfn "$HOME/.coderax/cli/0.2.0/bin/coderax" "$HOME/.local/bin/coderax"`.

## Releases

Every release publishes a GitHub Release with an npm tarball, a POSIX standalone
tarball, a Windows zip, `SHA256SUMS`, a release manifest, and an SPDX SBOM.
Builds are reproducible: `npm run repro` rebuilds twice and compares hashes.

Maintainer documentation: [docs/RELEASE.md](docs/RELEASE.md).
Distribution research and channel decisions: [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).
Supported runtimes and engine versions: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

```sh
npm run release:check    # syntax, tests, build, verify, repro, install-test
```

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
redacted if a server ever echoes it. `coderax compat` exits `1` when the engine
is outside the supported range or did not report a version.

## Development

```sh
npm ci --ignore-scripts   # dependency tree is empty by design
npm test                  # unit, CLI, redaction, and release tests
npm run check             # syntax check for every module
npm run build             # deterministic artifacts in dist/
npm run verify            # checksums, archive contents, install safety
npm run install-test      # install → authenticate → SDK → uninstall
```
