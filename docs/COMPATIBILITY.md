# Compatibility

Coderax CLI is a thin client for a Coderax **WorkflowEngine** deployment. It does
not guess compatibility from a version string in a health payload. It asks the
engine for its capability handshake and compares the three versioned surfaces the
canonical SDK validates:

| Surface | Pinned by | Meaning |
| --- | --- | --- |
| HTTP contract | `@coderax/sdk` 1.1.0 (`SDK_CONTRACT_VERSION`) | request/response shapes and the 30 published operations |
| Execution events | `SDK_EVENT_SCHEMA_VERSION` | durable task event framing |
| Chat stream | `SDK_CHAT_STREAM_VERSION` | versioned chat frames |

A deployment that does not serve a compatible contract fails with
`CONTRACT_INCOMPATIBLE` (exit `7`) before any operation is attempted. The CLI
never falls back to guessing, scraping OpenAPI or simulating an operation.

## Runtime

| Component | Supported | Notes |
| --- | --- | --- |
| Node.js | `>=24.0.0` | declared in `engines`; `coderax doctor` fails below it |
| Linux | x64, arm64 | GitHub-hosted `ubuntu-latest` in the CI matrix |
| macOS | arm64, x64 | GitHub-hosted `macos-latest` in the CI matrix |
| Windows | x64 | GitHub-hosted `windows-latest` in the CI matrix |
| Shell | sh, bash, zsh, fish, PowerShell 5.1+, cmd.exe | completion for four shells; POSIX and `.cmd` launchers |

The standalone archive bundles the pinned canonical SDK, its contracts and
`zod`, so it runs without `npm install`. No native modules, no build step and no
install hooks.

## WorkflowEngine

| Field | Value |
| --- | --- |
| Consolidation target | WorkflowEngine PR #7, `9b4cb5c` |
| Contract | `1.1.0` |
| SDK | `@coderax/sdk` `1.1.0`, `sha256:520a0cf8…73db` |
| Supported engine range | `>=1.0.0 <2.0.0` (`src/version.js`) |
| Reported by | `coderax capabilities`, `coderax readiness`, `coderax doctor`, `coderax status` |

`coderax capabilities` prints the served contract, every operation the engine
publishes, any SDK coverage gap, and each capability family's state. A family is
`available` only when the handshake publishes the flag and every operation the
command needs. It is `unverified` when the engine makes no claim, `unconfigured`
when a required provider is missing, and `not_implemented` when the contract has
no such operation. The CLI never upgrades a state on its own.

## CLI surface

Commands: `products`, `chat`, `work`, `interactive`, `models`, `agents`, `cloud`,
`projects`, `login`, `logout`, `status`, `config show|get|set`, `doctor`,
`version`, `update`, `completion`, `health`, `openapi`, `call`, `capabilities`,
`readiness`, `capability run`, the 20 capability commands, `upload`, `artifacts`,
`schedules`, `permissions`, `task`, `help`.

Exit codes are part of the contract:

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | task failure, integrity failure, conflict, other non-2xx |
| `2` | usage, configuration or local input validation |
| `3` | authentication/authorization failure, including an unavailable or corrupt credential store |
| `4` | network failure, timeout, or the local wait limit |
| `5` | not found |
| `6` | capability not available |
| `7` | incompatible contract or contract violation |
| `130` | cancelled |

## Authentication and transport

Remote base URLs must use HTTPS; plain HTTP is accepted only for `localhost`,
`127.0.0.1` and `::1`. Tokens are stored in the operating-system credential store
(macOS Keychain, Linux libsecret, Windows DPAPI), never in the config file.
`CODERAX_TOKEN` remains the CI path. See [INSTALL.md](INSTALL.md) and
[SECURITY.md](../SECURITY.md).

## What is not claimed

- Contract 1.1.0 publishes no device-code, refresh or revoke operation, so the
  CLI implements none of them.
- Media, creative and games families are absent from PR #7; they report
  `unverified` or `not_implemented`.
- PR #7 keeps artifacts and schedules in process memory. Durability across
  engine restarts or devices is not claimed until `feat/durable-artifacts`
  lands.
