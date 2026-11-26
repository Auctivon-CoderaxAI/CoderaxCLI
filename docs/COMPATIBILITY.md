# Compatibility

Coderax CLI is a thin client: one HTTP request at a time (plus SSE for chat and
Work) against a deployment's documented API. Compatibility is therefore about
the Node runtime, the operating system, the CLI's public module surface, and the
WorkflowEngine version the deployment reports.

## Runtime

| Component | Supported | Notes |
| --- | --- | --- |
| Node.js | `>=24.0.0` | Declared in `engines`; `coderax doctor` fails below it |
| Linux | x64, arm64 | Verified in this environment on `linux-x64`, Node 24.22.1 |
| macOS | arm64, x64 | Covered by the CI matrix (`macos-latest`) |
| Windows | x64 | Covered by the CI matrix (`windows-latest`) |
| Shell | sh, bash, zsh, PowerShell 5.1+, cmd.exe | POSIX launcher plus `coderax.cmd` |

No native modules, no build step, no optional dependencies.

## WorkflowEngine

| Field | Value |
| --- | --- |
| Supported range | `>=0.8.0 <1.0.0` |
| Prereleases | Not supported (reported, never trusted) |
| Declared in | `src/compat.js` (`SUPPORTED_ENGINE_RANGE`) |
| Reported by | `coderax version --json`, `coderax compat`, `coderax doctor` |

### How the version is detected

In order:

1. `GET /health`, `/api/health`, `/healthz` — read `workflowEngine.version`,
   `workflowEngineVersion`, `engine.version`,
   `services.workflowEngine.version`, or `capabilities.workflowEngine`.
2. The OpenAPI document (`/openapi.json`, `/api/openapi.json`,
   `/.well-known/openapi.json`) — read `info.version`.

A bare `version` field in a health payload is deliberately **ignored**: many
deployments report their web-service version there, and treating it as the
engine version would produce a confidently wrong answer.

### What happens when versions disagree

| Situation | `coderax compat` | `coderax doctor` | Other commands |
| --- | --- | --- | --- |
| Inside the range | exit `0`, `supported: true` | passes | run normally |
| Outside the range | exit `1`, `supported: false` with a reason | `engine` check fails | still run |
| Version not reported | exit `1`, `supported: null` | `engine` check passes with "not reported" | run normally |
| Unparseable version | exit `1`, `supported: null` | passes with "not reported" | run normally |

The CLI warns rather than blocks. Refusing to run against a newer engine would
turn a compatibility question into an outage, and `coderax call` is explicitly
an escape hatch. Automation that must enforce the range should check
`coderax compat --json` and treat a non-zero exit as a hard failure.

## CLI surface

Commands: `products`, `chat`, `work`, `models`, `agents`, `cloud`, `projects`,
`login`, `logout`, `status`, `config show|get|set`, `doctor`, `version`,
`compat`, `update`, `uninstall`/`cleanup`, `health`, `openapi`, `call`, `help`.

Exit codes are part of the contract:

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational failure, missing operation, incompatible/unknown engine |
| `2` | usage error or invalid configuration |
| `3` | authentication or authorization failure |
| `4` | network failure or timeout |
| `5` | not found |
| `6` | unavailable (Cloud/projects) |
| `130` | cancelled |

`coderax version --json` emits a stable, additive schema (`schemaVersion: 1`):
`cli`, `packageName`, `cliVersion`, `node`, `nodeRequirement`, `nodeSupported`,
`platform`, `arch`, `installMethod`, `installPath`, `configPath`, `configDir`,
`channel`, `supportedWorkflowEngine`.

## SDK surface

The package exposes an exports map, so consumers depend on named subpaths rather
than internal file layout:

| Import | Contents |
| --- | --- |
| `coderax-cli` | `runCli`, `parseArgv`, `isEntrypoint`, `VERSION` |
| `coderax-cli/client` | `request`, `streamRequest`, `redact`, `redactValue`, `formatJson`, `CoderaxError` |
| `coderax-cli/config` | `loadConfig`, `saveConfig`, `describeConfig`, `normalizeBaseUrl`, `maskToken` |
| `coderax-cli/discover` | `discoverOpenApi`, `summarizeOperations`, `findOperation` |
| `coderax-cli/compat` | `SUPPORTED_ENGINE_RANGE`, `parseSemver`, `compareSemver`, `isSupportedEngineVersion`, `checkEngineCompatibility` |
| `coderax-cli/diagnostics` | `collectVersionInfo`, `detectInstallMethod`, `formatVersionInfo` |
| `coderax-cli/product-registry` | `PRODUCTS`, `STATUS_LABELS`, product helpers |
| `coderax-cli/version` | `VERSION`, `PACKAGE_NAME`, `NODE_REQUIREMENT` |
| `coderax-cli/package.json` | Package metadata |

Adding an export is a minor release. Removing or renaming one is a major
release. The installation test imports every public entry point from an
installed tarball, so a broken exports map fails CI before release.

## Evidence

`npm run install-test` runs against the built release artifacts. This run
(Linux, Node 24.22.1) passed all 16 checks:

| Check | Result |
| --- | --- |
| Artifact verification (checksums, contents, modes, safety) | pass |
| Installer rejects unknown options | pass |
| Standalone install from tarball with checksum verification | pass |
| Launcher reports the released version | pass |
| `version --json` identifies a standalone install | pass |
| Help works with no configuration | pass |
| `doctor` reports node/install checks and missing auth | pass |
| Authenticated flow against engine `0.8.8` (`login`, `status`, `health`, `compat`, `agents`, `doctor`) | pass |
| Engine boundaries `0.7.9` (unsupported), `0.8.0` (supported), `0.9.5` (supported), `1.0.0` (unsupported) | pass |
| Engine reporting no version → `supported: null` | pass |
| Work SSE streaming through the installed launcher | pass |
| npm tarball imports through the exports map; `.bin/coderax` works | pass |
| npm global install into a sandbox prefix; reports `npm-global` | pass |
| Same-version reinstall refused; `--force` replaces in place | pass |
| No bearer token in any output (8,907 bytes scanned) | pass |
| Uninstall removes launcher, program directory, and credentials | pass |

Compatibility was exercised against a stub deployment that implements the
documented contract: OpenAPI 3.1 discovery, bearer authentication, `/api/user`,
`/api/agents`, health reporting, and the cumulative-snapshot Work SSE stream.

**Limitation:** no live Coderax deployment or credentials were available in this
environment, so these results prove conformance to the published contract, not
behaviour against a specific production engine build. Run the same checks
against your deployment with:

```sh
coderax compat --json
coderax doctor --json
coderax work "compatibility probe" --json
```

The macOS and Windows jobs perform the same installation test in CI; they are
defined but were not executed in this environment. Treat the platform column as
"configured" until the workflow has run.

## Repeating the evidence

```sh
npm ci --ignore-scripts
npm run build
npm run verify
npm run repro
npm run install-test
```

The install test writes `dist/install-evidence.json` with every check, its
duration, the platform, and the release commit.
