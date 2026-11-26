# Pinned WorkflowEngine contract

`workflow-engine-1.0.0.openapi.json` is a byte-for-byte copy of the
WorkflowEngine's generated OpenAPI document.

| Field | Value |
| --- | --- |
| Repository | `Auctivon-CoderaxAI/Coderax-WorkflowEngine` |
| Commit | `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` |
| Document | `openapi.json` |
| SHA-256 | `4be54dc95fe8b9c00d3521e8e289807716a928bc77c61cc173401303a048cf93` |
| HTTP contract | `1.0.0` |
| SDK | `@coderax/sdk` `1.0.0` |
| Event schema | `1` |

`test/contract-source.test.js` verifies the digest, the document version, the
route catalogue and the operation ids used by the CLI. The repository rule in
`.gitattributes` keeps `contracts/**` byte-exact on Windows, so the digest is
not made platform-dependent. `scripts/check-contract.mjs` checks the same
artifact locally and can also compare a live engine checkout. CI pins the same
commit for the real-engine harness job.

## Why the SDK is mirrored, not installed

`@coderax/sdk` and `@coderax/contracts` are `private: true` workspace packages
in the engine repository. They are not published to npm, and the CLI has no
paid registry or package subscription. The CLI therefore consumes the pinned
wire contract through a dependency-free mirror in `src/engine/contract.js`. It
does not define a second payload contract: route names, versions and response
shapes come from this document and the engine's schemas.

## Coordination note

This pin is shared with the `feat/engine-thin-client-v1` line of work. The
previously reported `feat/engine-thin-client` branch at `d12a8b5` is not
reachable in `CoderaxCLI`, `Coderax` or `Coderax-WorkflowEngine`; this branch
uses the authoritative artifact directly. A contract owner should confirm the
pin before a production release.

## Updating the pin

1. Check out the reviewed engine commit.
2. Copy its generated `openapi.json` here and update the table and
   `CONTRACT_SOURCE` in `src/engine/contract.js`.
3. Update the CI pin in `.github/workflows/ci.yml`.
4. Run `npm run test:contract`, `npm test` and the real-engine job before
   merging.
