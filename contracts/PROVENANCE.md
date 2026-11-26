# Pinned WorkflowEngine contract

`workflow-engine-1.0.0.openapi.json` is a byte-for-byte copy of the engine's
generated OpenAPI document.

| Field | Value |
| --- | --- |
| Repository | `Auctivon-CoderaxAI/Coderax-WorkflowEngine` |
| Commit | `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` |
| Document | `openapi.json` |
| SHA-256 | `4be54dc95fe8b9c00d3521e8e289807716a928bc77c61cc173401303a048cf93` |
| HTTP contract | `1.0.0` |
| SDK | `@coderax/sdk` `1.0.0` |
| Event schema | `1` |

`test/contract.test.js` verifies the digest, the version and that every route
this CLI calls exists in the document with the same operation id. A contract
change therefore fails the CLI suite instead of drifting silently. The digest
is computed over LF-normalized bytes, and `.gitattributes` pins this artifact
to LF, so a Windows checkout cannot produce a false drift failure.

## Why the SDK is mirrored, not installed

`@coderax/sdk` is a `private: true` workspace package in the engine
repository. It is not published to npm, and this repository has no paid
registry or package subscription. The CLI therefore consumes the same pinned
contract with a dependency-free client (`src/engine.js`). It does not define a
second payload contract: the route table and version come from this document,
and responses are validated against the fields the CLI consumes.

## Recovery note

The previously reported `feat/engine-thin-client` implementation at `d12a8b5`
is not present in any `Auctivon-CoderaxAI` repository: the commit is not
reachable in `CoderaxCLI`, `Coderax` or `Coderax-WorkflowEngine`, and no branch
with that name exists. This implementation is a reconstruction against the
authoritative SDK/contract above.

The sole cross-repository integration owner (`@nnabdelshahid`, named in the
engine's `.github/CODEOWNERS`) should confirm this pin before production use.
