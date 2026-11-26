# Architecture

```
argv ──► parseArgv ──► preflight ──► resolveSettings ──► command
                          │              │                │
                     usage errors   config.js        health / openapi /
                     (exit 2)       (env + file)     agents / models / call
                                                        │
                                                        └─► discover.js (OpenAPI)
                                                            client.js (legacy /api/*)

product commands (chat / work / products / cloud / login / doctor)
  └─► product-commands.js ─► product-registry.js
                           ├─► client.js (legacy /api/* HTTP + SSE)
                           └─► config.js (atomic 0600 config)

capability commands (capabilities / readiness / artifacts / schedules /
                     permissions / capability families)
  └─► capability-commands.js
        ├─► capability-registry.js ─► capability-catalog.js   (UX metadata)
        ├─► engine.js ─► @coderax/sdk 1.1.0                  (canonical client)
        │                └─► @coderax/contracts 1.1.0        (zod schemas)
        ├─► file-transfer.js                                 (validation, base64, digest)
        └─► client.js                                        (CoderaxError, redaction)

completion
  └─► completion.js ─► capability-catalog.js + the dispatch set
```

## Layers

| Module | Responsibility | Knows about |
| --- | --- | --- |
| `src/config.js` | resolve, validate, persist deployment settings | filesystem, environment |
| `src/client.js` | legacy `/api/*` request, error mapping, redaction, `CoderaxError` | `fetch` only |
| `src/discover.js` | find and summarize the deployment OpenAPI document | client |
| `src/product-registry.js` | canonical five-product status data | none |
| `src/product-commands.js` | chat, Work chat, products, Cloud, login, doctor | config, client, registry |
| `src/engine.js` | canonical SDK adapter, negotiation, work/event/artifact/schedule policy, error translation | `@coderax/sdk`, client |
| `src/capability-catalog.js` | command names, objective templates, MIME sets, states (UX only) | none |
| `src/capability-registry.js` | resolve each family against the live handshake | catalog, `@coderax/sdk` |
| `src/capability-commands.js` | discovery, readiness, execution, progress, artifacts, schedules, permissions | registry, engine, transfer |
| `src/file-transfer.js` | local validation, base64 encode/decode, destination safety, digest verification | client, filesystem |
| `src/completion.js` | bash/zsh/fish scripts from the dispatch set | catalog, version |
| `src/format.js` | shared table and byte formatting | none |
| `src/exit.js` | shared exit codes | none |
| `src/cli.js` | parsing, preflight, help, dispatch, output | all of the above |

`src/client.js` is the **legacy adapter** for deployments that still expose the
`/api/*` surface used by `chat`, `work`, `login`, `doctor` and `products`. It is
not a WorkflowEngine SDK and is never used for `/v1` capability work. The
canonical `@coderax/sdk` is the only WorkflowEngine client in the repository.

## Why a vendored SDK

`Coderax-WorkflowEngine` publishes `@coderax/sdk` 1.1.0 as a reproducible
tarball with a `sdk-artifact.json` manifest at pull request #7 (`9b4cb5c`). The
tarball bundles the matching `@coderax/contracts` schemas, so the CLI vendors
one `file:` dependency under `vendor/`, verified against the published SHA-256
in `vendor/PROVENANCE.md`. Benefits:

- one client implementation shared with Coderax Web and the engine's own tests;
- response and frame validation against the same zod schemas the server uses;
- a contract mismatch is a named client error, not a subtly wrong render;
- no hand-written copy of the transport that can drift from the contract.

`npm install` resolves the vendored tarballs plus `zod`; the lockfile pins the
exact tree.

## Ordering rules

`preflight` runs before config resolution so `coderax deplyo` says "unknown
command", not "no base URL configured".

Capability options are not hardcoded. The parser collects unknown long options;
preflight rejects them for ordinary commands, and the capability layer validates
them against the family's declared options before any network call. Execution
requires a negotiated handshake with the family's capability, prerequisites and
operations all available.

A capability request is one Work objective. The CLI does not decompose an
objective into steps; the engine's agent does that, and its steps arrive as
events. This is why adding a family does not add execution logic: it adds a
template and a requirement set.

## Failure semantics

| Condition | Code | Exit |
| --- | --- | --- |
| unknown command or flag misuse | `UsageError` / `USAGE` | 2 |
| HTTPS violated, bad URL, bad timeout | `BASE_URL_*`, `TIMEOUT_INVALID` | 2 |
| no deployment configured | `BASE_URL_REQUIRED` | 2 |
| request timeout | `REQUEST_TIMEOUT` | 4 |
| network failure | `NETWORK` | 4 |
| HTTP 401 or 403 | `UNAUTHENTICATED` | 3 |
| HTTP 404 | `NOT_FOUND` | 5 |
| HTTP 409 | `CONFLICT` | 1 |
| HTTP 503 | `UNAVAILABLE` | 6 |
| other 5xx | `SERVER_ERROR` | 4 |
| incompatible handshake | `CONTRACT_INCOMPATIBLE` | 7 |
| schema violation | `CONTRACT_VIOLATION` | 7 |
| capability not available | `CAPABILITY_NOT_AVAILABLE` | 6 |
| local upload, input or destination validation | `UPLOAD_*`, `ARTIFACT_DESTINATION_*`, `ARTIFACT_PATH_INVALID` | 2 |
| artifact digest or size mismatch | `ARTIFACT_INTEGRITY_FAILED` | 1 |
| local wait limit reached | `WAIT_TIMEOUT` | 4 |
| cancelled by the caller | `CANCELLED` | 130 |

## Deliberate constraints

- No submission retry. Reads may retry a transient transport failure with a
  bounded backoff; a `POST /v1/work` is sent exactly once.
- No redirects: the SDK uses `redirect: "error"`, so a token is never forwarded
  to another origin.
- No persistent HTTP agent, cookie jar or telemetry.
- No provider adapter, model call, document parser, generator or local
  execution. The CLI transfers inputs and renders engine results.
- No local artifact catalog: artifacts belong to the engine and are read from it.
- Uploads and downloads are bounded and hashed; downloads never overwrite
  without explicit `--force`.
- The token is never serialized into output, config summaries or error text.
