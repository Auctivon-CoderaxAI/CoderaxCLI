# CLI consolidation record

This branch reconciles the CLI against the **designated** WorkflowEngine target
(PR #7, `9b4cb5c`) and records which branch is authoritative for each component.
It does not claim that the competing CLI branches have been merged; it states
what is done, what is duplicated, and the order in which the owners should land
the rest.

## Engine target

| Surface | Authority | State |
| --- | --- | --- |
| API + SDK consolidation target | WorkflowEngine PR #7, `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f` | verified; hosted `verify` succeeded at that HEAD |
| Published SDK | `packages/sdk/artifacts/coderax-sdk-1.1.0.tgz` | `sha256:520a0cf8…73db`, 32,581 bytes |
| Contract served | `1.1.0`, 30 operations | verified against the real server |
| Competing 1.1.0 | `contract/authoritative-v1.1`, `ea66028` | different SDK, different artifact routes; **not** consumed |

The two 1.1.0 artifacts are not interchangeable: the authoritative branch exports
`negotiate()`/`parseSse()`/`SDK_COVERAGE` and `/v1/artifacts/{id}[/content]`; PR
#7 exports `handshake({contract})`/`compatibility()`/`SDK_OPERATION_COVERAGE` and
task-scoped `/v1/work/{taskId}/artifacts/{artifactId}`. This client negotiates
the served contract at runtime and gates every command on the operations the
engine actually publishes.

## Single authority per component

| Component | Authoritative implementation | Notes |
| --- | --- | --- |
| SDK integration | `src/engine.js` + vendored `@coderax/sdk` 1.1.0 | one client; no second transport |
| Command dispatch | `src/cli.js` | one parser and one exit-code map |
| Capability resolver | `src/capability-registry.js` | handshake flags + operation set + SDK coverage |
| Capability catalogue | `src/capability-catalog.js` | UX metadata only; no backend claims |
| Streaming parser | `@coderax/sdk` (`events()`, `chatStream()`) | the CLI does not parse SSE itself |
| Artifact transfer | `src/file-transfer.js` | validate, hash, base64, verify, non-overwrite |
| Task continuity | `@coderax/sdk` event cursor + `followTask()` | dedupe by `seq`/`eventId`, resume with `after` |
| Release pipeline | `release/installers-completion` | installers, reproducibility, completion installation |
| Interactive terminal | `feat/terminal-client-completion` | one TUI; not merged in this commit |
| Owner authentication | `feat/secure-owner-auth` | OS credential store + ACL verification; not merged in this commit |

## Duplicate implementations to retire

| Branch | Duplicate | Required action |
| --- | --- | --- |
| `feat/owner-cloud-client-contract` (PR #5) | `packages/workflow-sdk/**` | replace calls with `@coderax/sdk`; keep its product/auth work |
| `feat/secure-owner-auth` | `packages/workflow-sdk/**`, `src/workflow-commands.js` | keep `secure-store.js`/`credentials.js`; delete the second SDK and command surface |
| `feat/task-synchronization` | `packages/workflow-sdk/**`, `src/task-store.js` | map its cursor store onto the canonical event `seq`; delete the second SDK |
| `feat/terminal-client-completion` | `src/engine/client.js`, `src/engine/stream.js` | keep the TUI; call `src/engine.js` |
| `feat/engine-thin-client-v1` | `src/engine.js`, `src/sse.js` | superseded by this branch's adapter and the SDK stream |
| `feat/workflow-command-surface` | `packages/workflow-sdk/**`, `src/engine-client.js`, `src/sse.js` | keep release machinery; delete the duplicate client |

No branch is merged wholesale because every one of them rewrites `src/cli.js`
and several add a second SDK. Merging them as-is would create the competing
implementations this task forbids.

## Merge order

1. PR #4 (`ci/fix-work-sse-fixtures`) — test-only fixture correction.
2. PR #5 (`feat/owner-cloud-client-contract`) minus `packages/workflow-sdk`.
3. `feat/secure-owner-auth` — adopt `src/secure-store.js`, `src/credentials.js`,
   `src/auth.js`; rewire login/logout/status to `src/engine.js`.
4. PR #6 / `release/installers-completion` — one installer and release pipeline.
5. `feat/terminal-client-completion` — one TUI on `src/engine.js`.
6. `feat/task-synchronization` — cursor persistence over the canonical events.
7. This branch — capability, artifact, schedule and permission surface.

## Genuine integration evidence

Against the real PR #7 engine (`node dist/src/main.js`, in-memory persistence,
loopback port):

- handshake: contract `1.1.0`, compatible, 30 operations, **zero SDK coverage gaps**;
- available families: `upload`, `create-document`, `create-pdf`,
  `create-spreadsheet`, `create-presentation`, `analyze-data`, `visualize-data`,
  `generate-image`, `speak`, `create-software`;
- unverified: the multimodal and multi-agent families, because contract 1.1.0
  publishes no such flag or operation;
- `create-document --no-wait` returned an accepted task;
- `upload` stored a 64-byte PDF and the engine's digest matched the local SHA-256;
- `artifacts list --task` returned that record;
- `schedules create --interval-ms 60000` created a durable schedule, and
  `schedules pause` returned `outcome: accepted`;
- the task failed with `provider_error` only because the integration instance
  pointed at a deliberately unreachable inference endpoint; cancellation then
  returned `already_terminal`.

## Verification at this HEAD

- Local suite: **122 passed, 0 failed** (Node 24.22.1, Linux); vendor checksum verified.
- Real PR #7 engine: the integration evidence above was produced against
  `node dist/src/main.js` at `9b4cb5c`, over HTTP, not a mock.
- Hosted matrix: exact-HEAD run
  [`45888751533`](https://github.com/Auctivon-CoderaxAI/CoderaxCLI/actions/runs/45888751533)
  passed on `ubuntu-latest`, `macos-latest` and `windows-latest`.

## Remaining blockers

- No pull request exists for this branch. The workflow was given a push trigger
  for this branch so exact-HEAD CI could run; publication still needs the owner
  to open the PR.
- No authorised GitHub integration is connected to this chat; PR creation needs
  the owner or a token supplied outside the conversation.
- WorkflowEngine `main` still serves `1.0.0`; the target surface exists only on
  PR #7 and the competing authoritative branch.
- PR #7 stores artifacts and schedules in process memory. The durable-artifact
  branch (`feat/durable-artifacts`, `bf2e9b2`) is not merged into PR #7, so this
  client supports the published task-scoped contract and does not claim version
  history, project association or cross-device durability.
- Media, creative and games operations are absent from PR #7. Those families
  report `unverified` or `not_implemented`; they are never simulated.
- Owner-only auth, the interactive terminal and installers remain on their own
  branches until the merge order above is executed by their owners.
