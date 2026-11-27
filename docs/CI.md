# CI, compatibility and release engineering

CI uses standard GitHub-hosted runners and Node 24. Branch pushes and pull
requests can verify the candidate without publishing anything.

## Required workflow

The protected branch requires the `test` check from `.github/workflows/ci.yml`.
It fails unless platform verification, PTY acceptance and the dependency and
policy checks succeed.

| Job | What it proves |
| --- | --- |
| `verify` | Syntax, unit and HTTP integration tests, the npm shim in a clean prefix, release artifacts and hosted installer acceptance |
| `pty` | Real pseudo-terminal behavior on Linux and macOS |
| `dependencies` | Workflow policy, SDK and API contract, isolation, dependency audit |
| `test` | Aggregates every required job even when another job fails, is skipped or is cancelled |

## Coverage of the required checks

| Requirement | Verification |
| --- | --- |
| Windows, Linux, macOS compatibility | the `verify` matrix runs on all three operating systems for main and release candidates; other refs use Linux |
| Clean installation | `scripts/verify-package.mjs` installs the packed tarball with `npm install` into an empty prefix, with `--ignore-scripts`, and asserts only `coderax-cli` appears |
| Executable entrypoints | `test/package.test.js` checks the shebang, the executable bit, the single `bin` entry and `node src/cli.js`; `verify-package` runs the installed shim |
| Shared SDK package integrity | `test/package.test.js` pins the dependency-free ESM surface of `src/client.js`, the frozen registry, `src/version.js` and the dependency and isolation gates check module imports |
| API version compatibility | `scripts/lib/contract.mjs` rejects a deployment `info.version` below the contract minimum or outside the supported majors |
| Command registration and dispatch | `test/cli.test.js` drives every documented command and fails if any is reported as unknown |
| Owner-only authentication | `test/integration/cli-http.test.js` accepts the owner token, rejects another valid-looking token with 403/exit 3 and a missing token with 401/exit 3 |
| Secure credential storage | the same test asserts `0600` config, `0700` directory, atomic persistence, no token in `config show`, `status` or `logout` |
| Chat streaming | real SSE deltas over a socket, including a token echoed by the server and redacted from output |
| Work submission | the request must be `POST /api/work/chat` with the expected body, and cumulative snapshots must not duplicate or lose text |
| Stream integrity | a Work stream that ends without a `final` frame fails with a transport or incomplete-stream error instead of reporting a completed job |
| Cancellation | `SIGINT` cancels an in-flight stream and exits `130`; the abort path is also covered in-process so Windows runs it |
| Error handling and exit codes | real HTTP 401/403/404/500, a timeout, a usage error and an unavailable product assert exits 3/3/5/1/4/2/6 |
| Release artifact integrity | `test/package-artifact.test.js` builds twice, compares the SHA-256, extracts with the system `tar`, and checks every file hash, mode and the artifact allowlist |
| Dependency security | zero runtime dependencies, zero install scripts, lockfile v3 with only the root package, plus `npm audit` |

## Legacy HTTP harness coverage

The legacy Work chat endpoint does not provide verified coverage for the
following capabilities. They are marked `unsupported` in
`contract/workflow-engine.json` with a reason, and the contract job fails if a
capability claims support without a test titled `[capability:<id>]`:

- event replay
- reconnection
- resumption
- permission requests
- cross-client conversation continuity

The harness implements SSE `id:` replay so a future client can be verified
against it, but that is not a claim about the legacy endpoint. The SDK and CLI tests
cover the separate workflow and /v1 surfaces. Do not mark these supported
in the contract until they are implemented and tested on the legacy endpoint.

## Release process

```sh
npm run verify:package
npm run release:build -- --out-dir dist
cd dist && sha256sum -c SHA256SUMS
```

The build creates an npm tarball and standalone archives. Run `npm run repro`
for byte reproducibility and `npm run verify` for artifact checks. The
separate release workflow publishes only through a version tag or authorized
manual dispatch; ordinary CI does not publish a release.
