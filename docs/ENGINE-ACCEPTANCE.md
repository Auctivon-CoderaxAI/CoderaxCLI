# Engine acceptance record

This record captures the local cross-repository run performed while preparing
the CLI change. It is evidence, not a production claim.

| Item | Value |
| --- | --- |
| Date | 2026-11-27 |
| Host | cloud Linux x64 |
| Node.js | 24.22.1 |
| Engine source | `Auctivon-CoderaxAI/Coderax-WorkflowEngine` PR #7, commit `a048a0283e6aa32531f7a6c1b74034843230ab0f` |
| Contract | 1.2.0, events v1, chat v1 |
| Fingerprint | `sha256:dd90179e40429ed4e91b75e0e3606be668c8fd1a7cf068d1f2c4f329b4516f21` |
| SDK | `@coderax/sdk` 1.2.0, SHA-256 `223ce865ae0ccea8caf6246e35e1e3e0f486bbca3930e02ccaf6fe1f7a187a8c` |
| Engine build | `npm ci --ignore-scripts && npm run build` |
| Server | the engine's own `startTestApp()` on `127.0.0.1` (real router, service, auth and SSE; deterministic model gateway) |
| CLI source | `release/rc-v0.3.0`, commit `719516013b04c8562dcce07cf1e3f2f26ec1a222` |

## Commands and results

```text
$ node scripts/verify-engine-contract.mjs --engine <engine-checkout>
ok: true, contract 1.2.0, 40 operations, SDK 1.2.0 (40144 bytes)

$ npm run test:engine
tests 25, pass 25, fail 0

$ node scripts/run-engine-acceptance.mjs --engine <engine-checkout>
✔ the engine publishes the pinned 1.2.0 contract
✔ submit is idempotent, events replay durably and a second client sees the same task
✔ notifications are durable and acknowledgement is idempotent
tests 3, pass 3, fail 0

$ npm test
tests 186, pass 183, fail 0, skipped 3
```

The three skipped checks are the acceptance tests when
`CODERAX_ENGINE_URL`/`CODERAX_ENGINE_TOKEN` are unset. The acceptance runner
sets both and runs them; there is no pass claim without a server.

Release checks at the same CLI commit:

```text
$ npm run check      pass
$ npm run build      pass (3 artifacts, 65 inventoried files)
$ npm run verify     pass (58 npm files, 65 standalone files, 9 checksums)
$ npm run install-test  pass (23 checks on linux-x64)
$ npm run repro      pass (identical hashes across rebuilds)
```

## What the acceptance suite exercised

- `GET /v1/handshake` with the client's contract and fingerprint.
- `POST /v1/work` with a caller `idempotencyKey`; a duplicate key returned the
  original task with `replayed: true` instead of creating a second run.
- `GET /v1/work/{taskId}/events?after=<seq>` replay to a terminal
  `task.completed`, with `eventId`/`seq` ordering and a confirmed completion
  receipt.
- A second client (fresh store) read the same authoritative task and replayed
  the full history to the same cursor.
- `GET /v1/notifications` and `POST /v1/notifications/{taskId}` with an
  idempotent acknowledgement and a decreasing unread count.

## Not covered

- A deployed engine origin. The engine repository has no deployment; this run
  used its real in-process HTTP application.
- Process-restart durability of the event log (PR #14) and schedule dispatch
  (PR #9) are not merged into the pinned PR #7 branch.
- Permission approval against a tool-requiring task; the deterministic gateway
  used by the harness does not request a tool permission. The client and
  synchronizer paths are covered by unit tests with a contract stub.
- OS keychain storage, which remains unimplemented.

The `engine-acceptance` job in `.github/workflows/ci.yml` reproduces the pin
verification and the acceptance suite on a GitHub-hosted ubuntu runner against
the same pinned engine commit.
