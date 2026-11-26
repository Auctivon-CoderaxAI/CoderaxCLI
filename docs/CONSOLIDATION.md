# CoderaxCLI consolidation record

This document records the single authoritative CLI implementation and the
decisions that keep it from competing with the other published branches. It is
the coordination record for PR review; it is not a claim that unavailable
backend capabilities exist.

## Authority

| Concern | Authority | Status |
| --- | --- | --- |
| CLI transport | `src/engine/client.js` and `src/http.js` | One `/v1` JSON/SSE implementation |
| SDK/contract | `src/engine/contract.js`, pinned to WorkflowEngine `1.0.0` | Canonical shared contract; no second SDK |
| Streaming | `SseTextNormalizer`, `TextAssembler`, `src/engine/stream.js` | Strict SSE, snapshot/delta dedupe, replay and reconnect |
| Credentials | `src/credentials.js` | Native OS stores; `auto` fails closed |
| Commands | `src/commands/registry.js` | One list for validation and shell completion |
| Release | `scripts/package-release.mjs`, `scripts/verify-pack.mjs` | Existing release pipeline; no second candidate |

Integration foundation: `feat/consolidated-cli`, branched from
`feat/terminal-client-completion` at
`153f729cf71b91a6b7d8588283a79f7049e6ef88`. The verified thin-client transport
reference is `feat/engine-thin-client-v1` at
`0cd85bf80bc162157b1078ade2e6cc769f346951`; its strict SSE and event assembly
fixes are ported here rather than kept as a parallel client.

The legacy `/api` gateway clients in PR #5, PR #6 and
`feat/secure-owner-auth` are **not** merged. Their unique credentials and
terminal features already exist on the foundation branch. Keeping a second
transport would mean two execution authorities, which this consolidation
forbids.

## Contract policy

The authoritative backend is
`Auctivon-CoderaxAI/Coderax-WorkflowEngine`. The CLI supports the merged
`1.0.0` contract. Engine PR #7 serves `1.1.0`; it is not the final unified
contract, and no `1.2.0` contract or SDK has been published.

`src/engine/contract-support.js` classifies versions explicitly:

| Contract | Classification | Behaviour |
| --- | --- | --- |
| `1.0.0` | supported | Negotiate and use the verified routes |
| `1.1.0` | adapter-pending | Exit `7` with `CONTRACT_ADAPTER_PENDING`; do not guess routes |
| `1.2.0` | adapter-pending | Exit `7` until the canonical adapter exists |
| anything else | unsupported | Exit `7` with `CONTRACT_UNSUPPORTED` |

The requested 1.2.0 architecture (global artifact identities with task-scoped
projections, `writeMemory`, explicit scheduling operations, `GET /v1/tasks`,
one operation catalogue and one shared SDK) is the target. It is not implemented
in this branch because the backend contract does not exist to verify it.
No OpenAPI mirror or second SDK is added while waiting.

## Streaming and output

- `SseTextNormalizer` holds a trailing `\r` across reads, so a CRLF split across
  TCP chunks cannot become two line endings and a fabricated frame.
- `TextAssembler` treats a cumulative snapshot as authoritative. It emits only
  the unseen suffix, ignores a snapshot/delta duplicate, and emits one
  replacement when the answer is rewritten.
- `src/engine/stream.js` owns generation checks, replay cursors, duplicate event
  suppression, reconnect backoff and terminal states. A submission is never
  retried when its outcome is ambiguous.
- `work --json` has one top-level `summary`; the nested task result does not
  repeat it.
- Tokens are redacted from messages, details and diagnostics.

## Authentication

`login` verifies the token against the engine before saving it. The token is
held by macOS Keychain, Windows DPAPI (current-user scope), or Linux Secret
Service. `auto` no longer falls back to a plaintext file: if the native helper
is missing, login fails with `CREDENTIAL_BACKEND_MISSING` and tells the owner
how to opt into the private fallback explicitly with `--credential-store file`.
That fallback is labelled as a file, not as an OS credential store.

The merged 1.0.0 owner token is opaque to this client. The backend does not
publish JWT signing keys/JWKS, issuer/audience metadata, revocation, device
authorization, or refresh-token rotation endpoints for this CLI. Local
signature verification, JWT issuer/audience validation, revocation checks and
rotation therefore cannot be truthfully claimed here. Server-side rejection and
the single refresh attempt on `401` are the available verified behaviour.
Administrative role membership is not used to infer owner identity; the server's
owner verification remains authoritative.

## Command inventory

Top-level commands in `src/commands/registry.js`:

`chat`, `work`, `sessions`, `agents`, `models`, `notifications`, `permissions`,
`login`, `logout`, `status`, `auth`, `engine`, `doctor`, `config`, `completion`,
`products`, `cloud`, `projects`, `update`, `deploy`, `health`, `openapi`, `call`,
`help`, `version`.

Work subcommands: `run`, `submit`, `list`, `status`, `watch`, `attach`, `report`,
`cancel`, `resume`, `retry`, `resolve`, `uncertain`, `templates`.

The legacy `deploy`, `products`, `cloud`, `projects`, `openapi` and `call`
surfaces address an older deployment API. They are retained for compatibility
and do not fall back to a competing WorkflowEngine authority. The 1.0.0
WorkflowEngine does not implement the requested memory, schedules, artifacts,
plugins, browser-session, Game Studio or Gaming Agent operations, so the CLI
does not expose or simulate them.

## Branch and PR disposition

| Branch/PR | Disposition |
| --- | --- |
| PR #4, SSE fixture corrections | Preserve and review independently; its fixture intent is covered by the strict decoder tests here |
| PR #5, owner-only cloud client | Superseded transport; do not merge as a second authority |
| PR #6, release candidate | Superseded; its release work must be reconciled with the existing pipeline before any closure |
| `feat/secure-owner-auth` | Credential patterns reviewed; native-store selection ported; not merged as a separate client |
| `feat/workflow-engine-capabilities` | Useful 1.1.0 catalogue evidence; not final contract |
| `feat/terminal-client-completion` | Foundation |
| `feat/engine-thin-client-v1` | Transport/SSE reference; consolidated here |

No branch is recommended for closure until its unique functionality has been
incorporated and verified. This record does not authorize a merge, tag, package
publication or production change.

## Verification limitations

- Hosted CI evidence must be for the exact final commit. A passing run for an
  earlier head is not evidence for a later one.
- The real WorkflowEngine HTTP harness tests engine execution, not live model
  provider inference or production infrastructure.
- No deployed Coderax Web/gateway PR #319 environment and no MongoDB service are
  available in this workspace, so Web/CLI continuity, durable restart recovery
  and cross-client permission control cannot be exercised here.
- No GitHub PR/merge tool is available to this agent; the exact compare link and
  hosted checks are the deliverable, and independent approval remains with the
  repository owners.
