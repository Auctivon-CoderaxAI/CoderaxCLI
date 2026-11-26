# CI, compatibility and release engineering

Every check below runs on standard GitHub-hosted runners (`ubuntu-latest`,
`windows-latest`, `macos-latest`) with Node 24. There are no self-hosted
runners, service containers, repository secrets or paid services, and no
artifact is published outside the repository.

## Required workflow

`.github/workflows/ci.yml` has one gate, `ci gate`, that fails unless every job
succeeds. Branch protection should require only that check.

| Job | What it proves | Where |
| --- | --- | --- |
| `verify` (Ubuntu, Windows, macOS) | syntax, shared modules, parsing, config and redaction; the real CLI process against the HTTP harness; the packed tarball installed into a clean prefix | `npm run check`, `npm run test:unit`, `npm run test:integration`, `npm run verify:package` |
| `contract` | workflow policy, required operations, API version, version consistency, capability claims, dependency audit and the no-local-execution gate | `npm run verify:workflows`, `npm run verify:contract`, `npm audit`, `npm run verify:isolation` |
| `release` | reproducible tarball, `SHA256SUMS`, manifest, checksum verification and a second clean install | `npm run release:build`, `sha256sum -c`, `npm run verify:package` |
| `gate` | aggregates every result so a skip cannot pass | workflow expression |

## Coverage of the required checks

| Requirement | Verification |
| --- | --- |
| Windows, Linux, macOS compatibility | the `verify` matrix runs the same suite on `ubuntu-latest`, `windows-latest` and `macos-latest` |
| Clean installation | `scripts/verify-package.mjs` installs the packed tarball with `npm install` into an empty prefix, with `--ignore-scripts`, and asserts only `coderax-cli` appears |
| Executable entrypoints | `test/package.test.js` checks the shebang, the executable bit, the single `bin` entry and `node src/cli.js`; `verify-package` runs the installed shim |
| Shared SDK package integrity | `test/package.test.js` pins the dependency-free ESM surface of `src/client.js`, the frozen registry, `src/version.js` and relative/`node:` imports only |
| API version compatibility | `scripts/lib/contract.mjs` rejects a deployment `info.version` below the contract minimum or outside the supported majors |
| Command registration and dispatch | `test/cli.test.js` drives every documented command and fails if any is reported as unknown |
| Owner-only authentication | `test/integration/cli-http.test.js` accepts the owner token, rejects another valid-looking token with 403/exit 3 and a missing token with 401/exit 3 |
| Secure credential storage | the same test asserts `0600` config, `0700` directory, atomic persistence, no token in `config show`, `status` or `logout` |
| Chat streaming | real SSE deltas over a socket, including a token echoed by the server and redacted from output |
| Work submission | the request must be `POST /api/work/chat` with the expected body, and cumulative snapshots must not duplicate or lose text |
| Stream integrity | a Work stream that ends without a `final` frame exits 4 (`STREAM_INCOMPLETE`) instead of reporting a completed job |
| Cancellation | `SIGINT` cancels an in-flight stream and exits `130`; the abort path is also covered in-process so Windows runs it |
| Error handling and exit codes | real HTTP 401/403/404/500, a timeout, a usage error and an unavailable product assert exits 3/3/5/1/4/2/6 |
| Release artifact integrity | `test/release.test.js` builds twice, compares the SHA-256, extracts with the system `tar`, and checks every file hash, mode and the artifact allowlist |
| Dependency security | zero runtime dependencies, zero install scripts, lockfile v3 with only the root package, plus `npm audit` |

## Deliberately unsupported

The CLI is a cloud client with no local execution surface. These capabilities
do not exist in the client, so they are marked `unsupported` in
`contract/workflow-engine.json` with a reason, and the contract job fails if a
capability claims support without a test titled `[capability:<id>]`:

- event replay
- reconnection
- resumption
- permission requests
- cross-client conversation continuity

The harness implements SSE `id:` replay so a future client can be verified
against it, but the CLI makes no claim to use it. Do not mark these supported
in the contract until the client actually implements and tests them.

## Release process

```sh
npm run verify:package
npm run release:build -- --out-dir dist
cd dist && sha256sum -c SHA256SUMS
```

The tarball is a deterministic npm-compatible package: sorted paths, zero
mtimes, zero ownership and gzip without a timestamp. Two builds from the same
commit must produce the same SHA-256, and `release:build` fails if they do not.
Artifacts are uploaded to the workflow run for review only. Publishing to a
registry or anywhere else requires explicit authorization and is not wired up.
