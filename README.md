# Coderax CLI

Owner-only command-line client for a Coderax **WorkflowEngine** deployment.

It configures a deployment URL and token, chats and runs Work mode, discovers
which capabilities the engine actually implements, submits capability requests
as durable Work tasks, reports progress, and lists, verifies and downloads the
artifacts the engine produced.

The CLI is a control and access client. It does not parse documents, run
inference, generate artifacts or execute development work on your computer.

- Repository: `Auctivon-CoderaxAI/CoderaxCLI` (private)
- Runtime: Node.js 24
- Canonical SDK: `@coderax/sdk` `1.1.0`, published by
  [`Coderax-WorkflowEngine`](https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine)
  at pull request #7 (`9b4cb5c`) and vendored with its published SHA-256 in
  [`vendor/`](vendor/PROVENANCE.md)
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (deployment)

## One SDK, one contract

Transport, response parsing and event framing come from the canonical
`@coderax/sdk`. The CLI does not carry a second WorkflowEngine client:

| Concern | Owner |
| --- | --- |
| HTTP transport, schema validation, SSE framing | `@coderax/sdk` 1.1.0 (contracts bundled) |
| Contract/event/chat negotiation | `CoderaxClient.handshake({ contract })` and `checkCompatibility()` |
| Client policy (deadline, upload ordering, retry of reads) | `src/engine.js` |
| Capability families and objective templates (UX only) | `src/capability-catalog.js` |
| Handshake-derived status | `src/capability-registry.js` |
| Legacy `/api/*` deployment surface (chat, Work chat, products) | `src/client.js` (explicit legacy adapter) |

`src/client.js` remains the adapter for deployments that expose the older
`/api/*` routes used by `chat`, `work`, `login`, `doctor` and `products`. It is
labelled as the legacy adapter and is not used for any `/v1` capability work.

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

## Engine baseline

The CLI targets contract **1.1.0** and negotiates at runtime. `Coderax-WorkflowEngine`
`main` still publishes contract `1.0.0`; the designated 1.1.0 consolidation
target is pull request #7 (`9b4cb5c`), which serves 30 operations and passed its
hosted `verify` job at that commit. Against `main` the CLI reports an
incompatible contract; against PR #7 it discovers the families the engine
actually publishes. Nothing is simulated, and no local fallback exists.

`contract/authoritative-v1.1` publishes a **different** 1.1.0 SDK and artifact
surface. It is a competing implementation awaiting owner reconciliation; this
CLI does not merge the two or claim they are interchangeable.

## Status

| Area | Status |
| --- | --- |
| `config show/set`, environment precedence, `0600` persistence | ✅ implemented, tested |
| HTTPS enforcement (HTTP only on loopback) | ✅ implemented, tested |
| Owner login verified against the engine handshake, OS credential store (Keychain/libsecret/DPAPI), no plaintext token | ✅ implemented, tested |
| `login --token-file` / `--with-token`, `logout`, `status` with token masking | ✅ implemented, tested |
| Interactive terminal: streaming Markdown chat, durable Work, task/permission/artifact commands | ✅ implemented; PTY session and real Work and chat turns verified over HTTP |
| One installer, uninstaller, completion and release pipeline | ✅ build, verify and reproducibility checks pass locally |
| `chat` / `work` streaming through the legacy `/api/*` adapter | ✅ implemented, tested |
| `products`, `cloud`, `projects`, `doctor`, `health`, `openapi`, `call` | ✅ implemented, tested |
| Canonical `@coderax/sdk` 1.1.0 integration with provenance | ✅ vendored, pinned by SHA-256 |
| Handshake-driven capability resolution and fail-closed execution | ✅ implemented, tested over real HTTP |
| Task-scoped uploads with digest echo and cancel-on-failure | ✅ implemented, tested over real HTTP and a real PR #7 engine |
| Digest-verified downloads and overwrite protection | ✅ implemented, tested |
| Durable schedules (create/list/pause/resume/delete) and task-scoped permissions | ✅ implemented, tested over real HTTP and a real PR #7 engine |
| Shell completion generated from the dispatch set (bash, zsh, fish, PowerShell) | ✅ implemented, tested |
| Local document, inference, generation or execution work | ⛔ never — the CLI is a cloud client |
| Direct pushes, force pushes, production changes | ⛔ not performed |

## Interactive terminal

```sh
coderax interactive                 # chat mode
coderax interactive --mode work     # every prompt becomes a durable Work task
```

Inside the session, `/help`, `/mode`, `/task`, `/tasks`, `/cancel`, `/artifacts`,
`/permissions`, `/doctor`, `/models`, `/agents` and `/caps` are available. It
uses the same canonical SDK and `src/engine.js` as every non-interactive
command; chat frames and execution events are parsed once, and nothing is
simulated locally.

## Install

From a release archive (Linux and macOS):

```sh
sh install.sh --version 0.3.0
```

Windows PowerShell:

```powershell
.\install.ps1 -Version 0.3.0
```

From a checkout, for development:

```sh
npm ci              # installs the vendored canonical SDK and zod
npm link            # exposes `coderax`
node src/cli.js --help
```

The installers verify the release SHA-256, install under a versioned prefix,
refuse to overwrite without `--force`, and install shell completion. See
[`docs/INSTALL.md`](docs/INSTALL.md) for offline, rollback and prefix options.

## Configure and sign in

```sh
coderax config set --base-url https://coderax.example.com
coderax login --token-file ~/.coderax/owner-token   # or: ... | coderax login --with-token
```

Login verifies the token against the engine handshake and the owner-only agent
read before storing it. The credential is stored in the operating-system
credential store (macOS Keychain, Linux libsecret, or Windows DPAPI); the
config file holds only the deployment URL and account label, with mode `0600`
(override with `CODERAX_CONFIG`). There is no plaintext-token fallback.

Environment variables win over the file and the credential store, so CI can
inject a short-lived token without writing anything:

```sh
export CODERAX_BASE_URL=https://coderax.example.com
export CODERAX_TOKEN=...
```

Remote deployments must be HTTPS. `http://localhost`, `127.0.0.1` and `::1` are
allowed for local development.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | task failure, integrity failure, conflict, other non-2xx |
| `2` | usage, configuration or local input validation |
| `3` | authentication or authorization failure (HTTP 401/403) |
| `4` | network failure, timeout, or the local wait limit was reached |
| `5` | not found (HTTP 404) |
| `6` | capability not available (`unavailable`, `unconfigured`, `blocked`, `not_implemented`, `unverified`) |
| `7` | incompatible contract or contract violation |
| `130` | cancelled |

Errors print as `coderax: <CODE>: <message>`, with the token redacted if a
server ever echoes it.

## Verify

```sh
npm run check     # syntax of every module + vendored SDK checksum
npm test          # 122 unit + real-HTTP contract tests
npm run build     # release tarballs, installers, manifest, SBOM, checksums
npm run verify    # artifact, checksum, inventory and install-safety checks
npm run repro     # byte-identical rebuild, including dist/
```

The capability suite runs against `test/support/workflow-harness.js`, a real
HTTP server that validates every request and response with the published
`@coderax/contracts` schemas. It exercises refusal, upload ordering, digest
verification, cancellation, timeouts, schedules and permissions without a
network deployment or a paid service.
