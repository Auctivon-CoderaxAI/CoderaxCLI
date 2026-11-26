# Compatibility

Coderax CLI is a thin access client: HTTP requests and SSE against a Coderax
deployment. Compatibility is defined by one versioned client contract, not by a
guessed WorkflowEngine release range.

## Runtime

| Component | Supported | Verification |
| --- | --- | --- |
| Node.js | `>=24.0.0` | `coderax doctor` fails below it |
| Linux | x64 | Installed-artifact suite passes on `linux-x64`, Node 24.22.1 |
| macOS | arm64, x64 | GitHub-hosted `macos-latest` job in the CI matrix |
| Windows | x64 | GitHub-hosted `windows-latest` job in the CI matrix |
| Shell | sh, bash, zsh, fish, PowerShell 5.1+, cmd.exe | Completion scripts are generated for all four shells |

No native modules, no build step, no runtime dependencies.

## The API contract

The authoritative contract is the pinned SDK at
`packages/workflow-sdk` (`@coderax/workflow-sdk` 0.1.0). It declares:

| Field | Value | Source |
| --- | --- | --- |
| `API_VERSION` | `1` | `packages/workflow-sdk/src/contract.js` |
| `API_MAJOR` | `1` | `packages/workflow-sdk/src/contract.js` |
| Client header | `x-coderax-api-version: 1` | SDK transport |
| Metadata routes | `/api/meta`, `/.well-known/coderax.json`, `/api/version` | `ROUTE.meta` |

There is **no** hardcoded WorkflowEngine package-version range. The CLI does not
infer an engine version from `/health` or an OpenAPI `info.version`, because
those fields describe the web service, not the API surface the client uses.

### Negotiation

`WorkflowClient.negotiate()` reads the first metadata route that responds and
accepts `apiVersion`, `api_version`, `version`, or `api.version`. A reported
version must parse and match API major `1`. `assertCompatibleVersion()` throws
`API_VERSION_UNSUPPORTED` for any other major; a missing or unparseable version
is reported as `API_VERSION_UNVERIFIED`.

| Situation | `coderax compat` | `coderax doctor` | Other commands |
| --- | --- | --- | --- |
| Same major (`1.x`) | exit `0`, `supported: true` | `api-version` passes | run normally |
| Different major (`2.x`) | exit `6`, `supported: false` | `api-version` fails | fail closed with `API_VERSION_UNSUPPORTED` |
| No metadata route | exit `1`, `supported: null` | warning | run with an unverified-version diagnostic |
| `--strict` and no metadata | exit `6` | fails | fail closed |

`coderax compat --json` returns `supported`, `apiVersion`, `clientApiVersion`,
`owner`, and advertised `capabilities`. Automation can use the exit code as a
hard gate; a non-zero result must not be treated as compatible.

### Provenance of this contract

`contracts/PROVENANCE.md` records that the shapes were read from the Coderax
backend at commit `a5d237b0`. That is evidence of a reviewed reconstruction, not
owner sign-off. The WorkflowEngine SDK owner must still confirm the pinned
contract before this release is described as production-compatible. No live
Coderax deployment or authenticated gateway was available during this work, so
live integration is **not** verified.

## Evidence levels

| Evidence | What it proves |
| --- | --- |
| `npm test` (157 checks) | parser, SSE, redaction, task sync, API negotiation, release policy |
| `npm run install-test` (21 checks) | real install, launchers, checksums, completions, stub auth, upgrade/rollback, uninstall |
| GitHub Actions matrix | native Windows, macOS and Linux execution of the same suites |
| Stub deployment | protocol behavior against a local contract server |
| Live deployment | **not available**; no claim of live compatibility |

PowerShell-on-Linux is not used as evidence for Windows; Windows is verified
only by the native `windows-latest` job.

## CLI surface

`products`, `chat`, `work`, `work submit`, `tasks`, `workflows`, `runs`, `run`,
`cancel`, `resume`, `retry`, `approve`, `repos`, `agents`, `models`, `login`,
`logout`, `whoami`, `status`, `doctor`, `diagnostics`, `compat`, `health`,
`openapi`, `call`, `cloud`, `projects`, `update`, `version`, `config`,
`uninstall`, `cleanup`, `completion`, `help`.

The parser and all four completion scripts are generated from
`src/command-registry.js`. `test/completion.test.js` fails if a command or flag
is missing from a script.

## Public module surface

| Specifier | Exports |
| --- | --- |
| `coderax-cli` | `runCli`, `VERSION`, `isEntrypoint` |
| `coderax-cli/command-registry` | `COMMANDS`, `COMMAND_NAMES`, `FLAGS`, `SUBCOMMANDS` |
| `coderax-cli/completion` | `completionScript`, `COMPLETION_SHELLS`, `COMPLETION_MARKER` |
| `coderax-cli/diagnostics` | `collectVersionInfo`, `formatVersionInfo`, `detectInstallMethod` |
| `coderax-cli/version` | `VERSION`, `PACKAGE_NAME`, `NODE_REQUIREMENT` |

The npm tarball also contains `packages/workflow-sdk/src` for the CLI's runtime
import. The SDK is not a published package.

## Credential storage

The token is stored in the CLI config file with mode `0600` inside a `0700`
directory, or supplied through `CODERAX_TOKEN`. This is file-based protection,
not an OS keychain integration. A native credential-store backend (Windows
Credential Manager, macOS Keychain, libsecret) is **not implemented** and must
be completed and verified before the CLI claims OS credential storage.
