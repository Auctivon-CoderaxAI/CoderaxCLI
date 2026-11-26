# Compatibility

Coderax CLI is a thin client: HTTP requests and SSE against a deployment's
documented API. Compatibility therefore has two independent axes, and this
release reports them separately instead of collapsing them into one guessed
number.

## What changed, and why

Release `0.2.0` declared a hardcoded "WorkflowEngine" range of `>=0.8.0 <1.0.0`
and read it from `/health`. That was not derived from any authoritative signal:

- the reference deployment (`Auctivon-CoderaxAI/Coderax`) is `v0.8.8`, and its
  `/health` endpoint returns the plain text `OK` with no version;
- `packages/workflow-sdk/src/contract.js` records that the deployment publishes
  no `/api/meta` and no API-version endpoint (at the commit the contract was read
  from), so the client sends `x-coderax-api-version: 1` and records
  `API_VERSION_UNVERIFIED` when nothing answers;
- the separate `Coderax-WorkflowEngine` package is `0.1.0`, which the old range
  would reject.

The range is now derived from the API contract the CLI implements and the
deployment release it was validated against.

## Axis 1 — API version (authoritative handshake)

| Field | Value |
| --- | --- |
| Implemented by | `packages/workflow-sdk/src/contract.js` (`API_VERSION = "1"`) |
| Sent by | every SDK request: `x-coderax-api-version: 1` |
| Read from | `/api/meta`, `/.well-known/coderax.json`, `/api/version`, or a response header |
| Supported | major `1` |
| A different major | `API_VERSION_UNSUPPORTED`, exit `6` |

A missing API version is **unverified**, never assumed compatible. `--strict`
turns that into a failure for automation that requires a pinned contract.

## Axis 2 — Deployment version (published contract)

| Field | Value |
| --- | --- |
| Read from | the deployment's OpenAPI document, `info.version` |
| Supported range | `>=0.8.8 <1.0.0` |
| Floor evidence | the reference deployment release the SDK contract was read from |
| Ceiling | the next major line; a breaking deployment change is a major release |

Prereleases are reported and never trusted. An unparseable or missing version is
unknown.

## Verdict matrix

`coderax compat` exits `0` only when both axes are affirmatively supported.

| API version | Deployment version | `supported` | Exit | Meaning |
| --- | --- | --- | --- | --- |
| `1.x` | in range | `true` | `0` | compatible |
| other major | in range | `false` | `1` | the CLI speaks a different API contract |
| `1.x` | outside range | `false` | `1` | deployment release is older or newer than validated |
| missing | in range | `null` | `1` | API compatibility unverified |
| `1.x` | missing | `null` | `1` | deployment version unknown |
| missing | missing | `null` | `1` | unavailable / no metadata |
| HTTP 401/403 | — | — | `3` | unauthenticated, not an unknown version |
| timeout / network error | — | — | `4` | unreachable, not an unknown version |

The CLI warns rather than blocking ordinary commands. Refusing to run would turn
a compatibility question into an outage, and `coderax call` is an explicit escape
hatch. Automation that must enforce compatibility should check
`coderax compat --json` and treat any non-zero exit as a hard failure.

`coderax version --json` reports the same contract:

```json
{
  "schemaVersion": 1,
  "cliVersion": "0.3.0",
  "supportedApiVersion": "1.x",
  "supportedDeploymentRange": ">=0.8.8 <1.0.0",
  "compatibilityBasis": "x-coderax-api-version handshake (shared SDK) + OpenAPI info.version"
}
```

## Runtime and platforms

| Component | Supported | Notes |
| --- | --- | --- |
| Node.js | `>=24.0.0` | Declared in `engines`; `doctor` fails below it |
| Linux | x64, arm64 | Executed here: `linux-x64`, Node 24.22.1 |
| macOS | arm64, x64 | Hosted `macos-latest` job configured |
| Windows | x64 | Hosted `windows-latest` job configured |
| Shell | sh, bash, zsh, PowerShell 5.1+, cmd.exe | POSIX launcher plus `coderax.cmd` |

No native modules, no build step, no optional dependencies.

## CLI and SDK surface

Commands: `login`, `logout`, `whoami`, `status`, `chat`, `work`, `work submit`,
`tasks`, `workflows`, `runs`, `run`, `cancel`, `resume`, `retry`, `approve`,
`repos`, `agents`, `models`, `products`, `cloud`, `projects`, `doctor`,
`diagnostics`, `version`, `compat`, `update`, `uninstall`/`cleanup`, `health`,
`openapi`, `call`, `config`, `help`.

| Import | Contents |
| --- | --- |
| `coderax-cli` | `runCli`, `parseArgv`, `isEntrypoint`, `VERSION` |
| `coderax-cli/client` | `request`, `streamRequest`, `redact`, `CoderaxError` |
| `coderax-cli/compat` | `SUPPORTED_API_VERSION`, `SUPPORTED_DEPLOYMENT_RANGE`, `checkCompatibility`, semver helpers |
| `coderax-cli/credentials` | `credentialBackend`, `readCredential`, `writeCredential`, `readTokenFile` |
| `coderax-cli/sdk` | `WorkflowClient`, `API_VERSION`, `CAPABILITY`, `ROUTE` |
| `coderax-cli/sdk/contract` | the frozen contract constants |

Adding an export is a minor release; removing or renaming one is a major release.
The installation test imports the public entry points from an installed tarball.

## Evidence

Measured on `linux-x64`, Node 24.22.1, for this branch:

| Check | Result |
| --- | --- |
| Unit, CLI, contract, redaction and release tests | **128 / 128 pass** |
| Packed-artifact installation acceptance | **20 / 20 checks pass** |
| Reproducible build (two builds plus `dist/`) | identical hashes |
| Artifact verification (checksums, modes, contents, embedded extractor) | pass |

The 20 installation checks cover: hostile archives (traversal, absolute path,
symlink, duplicate, overwrite), a path with spaces and Unicode, non-interactive
entrypoints, `version --json`, doctor before configuration, refusal of a token in
argv, stdin login, compatible / incompatible-API / older / unavailable /
unauthenticated states, Work SSE streaming, npm SDK imports and bin, npm global
install, refused reinstall, corrupted upgrade leaving the install intact, atomic
force upgrade retaining a rollback directory, token-leak scanning, and uninstall.

**Limitations, stated plainly:**

- macOS and Windows were **not executed in this environment**. Their jobs are
  defined in `.github/workflows/ci.yml`; a hosted run is required before
  claiming those platforms pass.
- No live Coderax deployment or owner credential was available. The stubs prove
  conformance to the published contract, not behaviour against a specific
  production build.
- No interactive TTY session was driven. The hidden prompt is implemented and
  the non-interactive paths are tested; a real terminal check is still required.

## Repeating the evidence

```sh
npm ci --ignore-scripts
npm test
npm run build && npm run verify && npm run repro
npm run install-test
```

`dist/install-evidence.json` records every check, its duration, platform, release
commit and compatibility basis.
