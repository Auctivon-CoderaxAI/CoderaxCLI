# Compatibility

Coderax CLI is a thin owner-access and control client. It speaks two explicitly
separated surfaces:

| Surface | Contract | Status |
| --- | --- | --- |
| `coderax engine …` | WorkflowEngine `/v1` **1.2.0**, events v1, `@coderax/sdk` 1.2.0 | **Authoritative** |
| `coderax work/tasks/workflows/…` | legacy Coderax `/api/*`, `coderax-api/1` | **Temporary compatibility adapter** |

The authoritative backend for the ecosystem is the separate
`Auctivon-CoderaxAI/Coderax-WorkflowEngine` repository. The legacy in-repository
workflow implementation in `Auctivon-CoderaxAI/Coderax` is a migration
dependency, not the target contract.

## Runtime

| Component | Supported | Verification |
| --- | --- | --- |
| Node.js | `>=24.0.0` | `coderax doctor` fails below it |
| Linux | x64 | installed-artifact suite on `linux-x64` |
| macOS | arm64, x64 | GitHub-hosted `macos-latest` matrix job |
| Windows | x64 | GitHub-hosted `windows-latest` matrix job |
| Shell | sh, bash, zsh, fish, PowerShell 5.1+, cmd.exe | completion generated for all four shells |

No native modules, no build step, no runtime dependencies in the distributed
archive.

## Authoritative engine contract

The pinned contract is byte-identical to WorkflowEngine PR #7 at
`a048a0283e6aa32531f7a6c1b74034843230ab0f`:

| Field | Value |
| --- | --- |
| HTTP contract | `1.2.0` (major `1`; supported `1.0.0`, `1.1.0`, `1.2.0`) |
| Fingerprint | `sha256:dd90179e40429ed4e91b75e0e3606be668c8fd1a7cf068d1f2c4f329b4516f21` |
| OpenAPI SHA-256 | `7d73c5cdf58554fcd807b6c08f00fb42135762ea0e97b74cd62e274733b0efa1` |
| SDK | `@coderax/sdk` `1.2.0`, SHA-256 `223ce865…187a8c`, 40,144 bytes |
| Events | schema `1` with `eventId`, per-task `seq`, `stream.truncated` |
| Chat | frame schema `1` |

`coderax engine status` sends `GET /v1/handshake?contract=1.2.0&fingerprint=…`.
It fails closed when the server reports another major, does not support `1.2.0`,
emits another event/chat schema, does not publish an operation the CLI requires,
or reports the same version with a different catalogue fingerprint. A version
string alone is never accepted as compatibility.

The full operation list, durable rules and acceptance evidence are in
[`ENGINE.md`](ENGINE.md). Provenance and the SDK pin rationale are in
[`../contracts/PROVENANCE.md`](../contracts/PROVENANCE.md).

### Why the CLI does not import the SDK tarball

`@coderax/sdk` 1.2.0 is a `private: true` TypeScript workspace package with a
`zod` runtime. The CLI is distributed as a dependency-free standalone archive,
so it consumes the same pinned route catalogue, fingerprint and byte-identical
OpenAPI with `src/engine-client.js`. The mirror is gated by a contract test, a
route-coverage test and a cross-repository acceptance run against the real
engine application. If the engine publishes an installable SDK, the client
module is the single replacement point.

## Legacy adapter

`packages/workflow-sdk` remains for deployments that still expose only
`/api/*`. It is marked `LEGACY_ADAPTER` / `coderax-legacy-api-adapter` and is not
a competing authority:

- its `API_VERSION`/`API_MAJOR` (`1`) describe `coderax-api/1`, not the engine;
- its run stream emits full snapshots with no event ids, sequence numbers or
  `Last-Event-ID` support, so it cannot provide durable replay;
- its build route accepts no server-side idempotency key, so an ambiguous
  submission is never retried automatically;
- no new capability is added there.

`coderax compat` and `doctor` still inspect the legacy negotiation
(`/api/meta`, `/.well-known/coderax.json`, `/api/version`) for those
deployments. `coderax engine status` is the authoritative check on `/v1`.

## Evidence levels

| Evidence | What it proves |
| --- | --- |
| `npm test` — 186 checks | parser, SSE, redaction, legacy task sync, engine contract, client, durable sync, release policy |
| `npm run test:engine` — 25 checks | route/fingerprint pin, operation coverage, handshake, Problem mapping, SSE, dedupe, gaps, truncation, idempotency, partition, privacy |
| `node scripts/run-engine-acceptance.mjs` — 3 checks | real WorkflowEngine HTTP application: pin, idempotent submit, durable replay, second client, notifications |
| GitHub Actions `engine-acceptance` | builds the pinned engine commit and runs the acceptance suite against its real HTTP application on a hosted runner |
| `npm run install-test` — 23 checks | real install, launchers, checksums, completions, stub auth, upgrade/rollback, uninstall |
| GitHub Actions matrix | native Windows, macOS and Linux execution of the same suites |
| Live production deployment | **not available**; no claim of live compatibility |

The three acceptance checks are skipped when `CODERAX_ENGINE_URL` and
`CODERAX_ENGINE_TOKEN` are unset; `npm test` reports them as skipped, not passed.
PowerShell-on-Linux is not evidence for Windows.

## CLI surface

`products`, `chat`, `work`, `work submit`, `tasks`, `engine` (`status`,
`handshake`, `submit`, `tasks`, `task`, `events`, `cancel`, `resume`, `retry`,
`permissions`, `approve`, `deny`, `notifications`, `ack`, `reconcile`),
`workflows`, `runs`, `run`, `cancel`, `resume`, `retry`, `approve`, `repos`,
`agents`, `models`, `login`, `logout`, `whoami`, `status`, `doctor`,
`diagnostics`, `compat`, `health`, `openapi`, `call`, `cloud`, `projects`,
`update`, `version`, `config`, `uninstall`, `cleanup`, `completion`, `help`.

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
| `coderax-cli/engine-contract` | `ROUTES`, `CONTRACT_VERSION`, `CONTRACT_FINGERPRINT`, `contractFingerprint` |
| `coderax-cli/engine-client` | `EngineClient`, `SDK_METHOD_COVERAGE` |
| `coderax-cli/engine-sync` | `EngineTaskSynchronizer`, `enginePartition`, `createEngineStateStore` |
| `coderax-cli/version` | `VERSION`, `PACKAGE_NAME`, `NODE_REQUIREMENT` |

The npm tarball also contains `packages/workflow-sdk/src` for the legacy runtime
import and `contracts/` for the pinned engine document.

## Credential storage

The token is stored in the CLI config file with mode `0600` inside a `0700`
directory, or supplied through `CODERAX_TOKEN`. This is file-based protection,
not an OS keychain integration. A native credential-store backend (Windows
Credential Manager, macOS Keychain, libsecret) is **not implemented** and must
be completed and verified before the CLI claims OS credential storage.
