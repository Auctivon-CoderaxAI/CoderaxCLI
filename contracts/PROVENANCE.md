# Pinned WorkflowEngine contract

`workflow-engine-1.0.0.openapi.json` is a byte-for-byte copy of the
WorkflowEngine's generated OpenAPI document. It is vendored, not hand-written,
and `test/v1-contract.test.js` fails when the digest or the route catalogue
changes without this table being updated.

| Field | Value |
| --- | --- |
| Repository | `Auctivon-CoderaxAI/Coderax-WorkflowEngine` |
| Commit | `7b7c9d7a88b8e483995ebe445f2bbbdd29050229` (current `main`) |
| Document | `openapi.json` |
| SHA-256 | `66add22a0d38405e9aaa49a62a9e463648df00457ce0b0080e3cca240c9736f4` |
| HTTP contract | `1.0.0` |
| SDK | `@coderax/sdk` `1.0.0` (private workspace package) |
| Event schema | `1` |
| Operations | 17, all under `/v1` |

Verified against engine `main` on 2026-11-27: `main` points at `7b7c9d7a`, and
the published `openapi.json` hashes to the value above. The pin is therefore
current, not a stale 1.0.0 that the engine has since replaced.

The engine kept `info.version` at `1.0.0` while adding optional fields
(`reasoning` on a Work submission and task status, `dependsOn` and `attempts` on
a step, and `verification` on a result). Those additions are accepted by the
strict validators and are covered by `test/v1-client.test.js` and
`test/v1-submit.test.js`. A version alone would not distinguish the two
documents, so the pin records the commit and digest as well; see W3 in
`BACKEND-DEFECTS.md`.

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
`{ kind: 'json' }`. The `coderax engine chat` client requests JSON. Apply
[the Chat overlay](workflow-engine-chat.overlay.json) to describe that runtime
behavior. The overlay uses the pinned engine’s `ChatReply` schema and leaves the vendored
bytes and digest intact. The shared SDK continues to accept both shapes; see
`BACKEND-DEFECTS.md` for the upstream correction.
