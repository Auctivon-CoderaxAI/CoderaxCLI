# Pinned WorkflowEngine contract

`workflow-engine-1.2.0.openapi.json` is a byte-for-byte copy of the engine's
generated OpenAPI document from the authoritative contracts/SDK branch.

| Field | Value |
| --- | --- |
| Repository | `Auctivon-CoderaxAI/Coderax-WorkflowEngine` |
| Pull request | #7 `feat(contracts): one versioned 1.1.0 API surface, shared SDK artifact and HTTP contract harness` |
| Branch | `freebuff/5e5de30e8775a8e9225cc0e2` |
| Commit | `a048a0283e6aa32531f7a6c1b74034843230ab0f` |
| Document | `openapi.json` |
| SHA-256 | `7d73c5cdf58554fcd807b6c08f00fb42135762ea0e97b74cd62e274733b0efa1` |
| HTTP contract | `1.2.0` (majors `1`; supported `1.0.0`, `1.1.0`, `1.2.0`) |
| Fingerprint | `sha256:dd90179e40429ed4e91b75e0e3606be668c8fd1a7cf068d1f2c4f329b4516f21` |
| SDK | `@coderax/sdk` `1.2.0` |
| SDK artifact | `packages/sdk/artifacts/coderax-sdk-1.2.0.tgz`, 40,144 bytes |
| SDK artifact SHA-256 | `223ce865ae0ccea8caf6246e35e1e3e0f486bbca3930e02ccaf6fe1f7a187a8c` |
| Event schema | `1` (stable `eventId`, per-task `seq`, `stream.truncated`) |
| Chat stream | `1` (`chat.started`, `chat.delta`, `chat.replace`, `chat.completed`, `chat.failed`) |

`test/engine-contract.test.js` verifies this digest, the version, the
fingerprint and every operation the CLI calls. `scripts/verify-engine-contract.mjs`
performs the same checks against a real engine checkout, including the SDK
version and artifact digest, so the pin cannot silently drift.

## What this replaces

The CLI previously treated the legacy Coderax `/api/*` reconstruction as its
authoritative contract (`packages/workflow-sdk`, contract `coderax-api/1`). That
client is now an explicitly marked temporary adapter
(`LEGACY_ADAPTER` in `packages/workflow-sdk/src/legacy.js`). It remains only for
deployments that have not migrated; it defines no new capability and does not
compete with the `/v1` engine contract.

The legacy Coderax repository's in-repository workflow implementation is a
migration dependency. The separate WorkflowEngine repository is the intended
authoritative backend for the ecosystem.

## State of the upstream branch

At inspection time (2026-11-27):

- `Coderax-WorkflowEngine` `main` was `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd`,
  publishing contract `1.0.0` without the handshake, `/v1/tasks`,
  `idempotencyKey`, artifact or schedule operations.
- PR #7 was **open, not merged**, at `a048a028...`, and is the source of this
  pin. PR #14 (`feat/durable-recovery-rebased`, head `3f12b6de...`) carries the
  durable event log and crash recovery; PR #9 carries schedules.
- The repository has no deployment (`deploy/README.md`: "Current state: not
  deployed"). Live acceptance therefore runs against the engine's real
  in-process HTTP application, not a production origin.

Pinning an unmerged PR is deliberate: it is the only public branch that contains
the authoritative SDK and the 1.2.0 wire. The dependency-linked merge order is
recorded in [`docs/MERGE-PLAN.md`](../docs/MERGE-PLAN.md). The engine's code
owner must confirm the pin before this CLI is described as production-compatible.

## Why the CLI mirrors the SDK at runtime

`@coderax/sdk` 1.2.0 is a `private: true` TypeScript workspace package with a
`zod` runtime. The CLI is distributed as a dependency-free standalone archive
(the release contains no `node_modules`), so installing the SDK at runtime would
require bundling zod and a build step into every platform archive, against the
lightweight owner-access constraint. The CLI therefore consumes the same pinned
contract with `src/engine-client.js` and is gated three ways:

1. a byte-identical OpenAPI document and the exact catalogue fingerprint;
2. a route/operation coverage test for every published operation;
3. a cross-repository acceptance run against the real engine application using
   the actual `@coderax/sdk` in that repository's harness.

If the engine later publishes the SDK to a registry the CLI can depend on, the
mirror should be replaced by a direct import; the contract and synchronizer
boundaries are already separated for that change.
