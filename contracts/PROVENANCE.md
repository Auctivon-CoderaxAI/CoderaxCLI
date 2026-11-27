# Pinned WorkflowEngine contract

`workflow-engine-1.0.0.openapi.json` is a byte-for-byte copy of the
WorkflowEngine's generated OpenAPI document. It is vendored, not hand-written,
and `test/v1-contract.test.js` fails when the digest or the route catalogue
changes without this table being updated.

| Field | Value |
| --- | --- |
| Repository | `Auctivon-CoderaxAI/Coderax-WorkflowEngine` |
| Commit | `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` (current `main`) |
| Document | `openapi.json` |
| SHA-256 | `4be54dc95fe8b9c00d3521e8e289807716a928bc77c61cc173401303a048cf93` |
| HTTP contract | `1.0.0` |
| SDK | `@coderax/sdk` `1.0.0` (private workspace package) |
| Event schema | `1` |
| Operations | 16, all under `/v1` |

Verified against engine `main` on 2026-11-27: the engine's `main` still points at
`808dfd37`, and the published `openapi.json` hashes to the value above. The pin
is therefore current, not a stale 1.0.0 that the engine has since replaced.

## Version policy

The client accepts any server reporting major `1`. A server reporting a newer
`1.x` minor is used and records a `CONTRACT_MINOR_NEWER` diagnostic, because a
newer minor may add optional fields this mirror rejects as strict violations. A
server reporting a different major is refused with `CONTRACT_UNSUPPORTED`; there
is no silent downgrade.

`CONTRACT_VERSION` in `packages/workflow-sdk/src/v1/contract.js` is the version of
the vendored document. It is not a promise that the engine will stay at 1.0.0:
when the WorkflowEngine publishes a new contract, update the whole pin in one
change (document, digest, commit, `CONTRACT_VERSION`, this table, and any route
or validator that changed).

## Why the contract is mirrored, not installed

`@coderax/sdk` and `@coderax/contracts` are `private: true` workspace packages in
the engine repository. They are not published to a registry this project can
install from. The CLI therefore consumes the pinned wire contract through a
dependency-free mirror inside its one shared SDK
(`packages/workflow-sdk/src/v1/`). It does not define a second payload contract:
routes, versions and payload shapes come from the vendored document and the
engine's own zod schemas.

The mirror lives in the shared SDK, not in `src/`, so Coderax Web and any other
supported client can consume the same implementation instead of writing a third.

## Updating the pin

1. Check out the reviewed engine commit.
2. Copy its generated `openapi.json` to `contracts/workflow-engine-<version>.openapi.json`.
3. Update this table and `CONTRACT_SOURCE` in `packages/workflow-sdk/src/v1/contract.js`.
4. Update `CONTRACT_VERSION` and any changed validator.
5. Run `npm run test:contract`, `npm test`, and the real-engine job before merging.

## Known engine contract defect

`/v1/chat` is declared `stream: true` with a `text/event-stream` response in the
published document, but `src/api/routes.ts` registers `submitChat` as
`{ kind: 'json' }`. The CLI accepts both shapes and reports the mismatch in
`BACKEND-DEFECTS.md`; the engine owner should either stream the reply or mark the
route as JSON.
