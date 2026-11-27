# Dependency-linked merge plan

The ecosystem has three repositories. This plan keeps exactly one contract, one
SDK and one task authority, and states the order in which the work can land.

```
Coderax-WorkflowEngine PR #7   (contracts 1.2.0 + @coderax/sdk 1.2.0)
        │
        ├── PR #14  durable execution events / crash recovery (rebased onto #2)
        ├── PR #9   durable schedules
        ▼
Coderax-WorkflowEngine main    (currently 808dfd3, contract 1.0.0)
        │
        ▼
CoderaxCLI release/rc-v0.3.0   (this branch: engine client + durable sync)
        │
        ▼
Coderax (Web) /v1 consumer
```

## Upstream order

1. **WorkflowEngine #7** — `feat(contracts): one versioned API surface, shared
   SDK artifact and HTTP contract harness`, head
   `a048a0283e6aa32531f7a6c1b74034843230ab0f`. This is the authority for
   `openapi.json` 1.2.0, the route catalogue, the fingerprint and
   `@coderax/sdk` 1.2.0. Nothing else should define a competing HTTP contract.
2. **WorkflowEngine #14** — `feat/durable-recovery-rebased`, head
   `3f12b6de…`. Adds the durable event log and crash recovery that make replay
   survive a process restart. The CLI's cursor protocol already matches the
   schema; this PR supplies the persistence side.
3. **WorkflowEngine #9** — `feat/durable-scheduling`. Adds the schedule
   operations the CLI client already covers.
4. **WorkflowEngine main** — merge order #7 → #14 → #9. After #7, `main` serves
   1.2.0 and the CLI pin no longer references an open PR.

The engine owner (`@nnabdelshahid`, per `.github/CODEOWNERS`) must confirm the
contract and SDK pin. Until then, compatibility is verified, not owner-signed.

## CLI order

1. `release/rc-v0.3.0` (existing release candidate; 158-test baseline).
2. This change: `src/engine-contract.js`, `src/engine-client.js`,
   `src/engine-events.js`, `src/engine-sse.js`, `src/engine-sync.js`,
   `src/engine-commands.js`, `contracts/`, engine tests and acceptance script.
   It is additive: the legacy `cli.js` dispatch gains one `case "engine"`, the
   command registry gains one command and subcommands, and no existing
   product/workflow handler is rewritten.
3. Native CI matrix (Windows, macOS, Linux) must pass at the exact HEAD before
   review.
4. Merge only after WorkflowEngine #7 is merged or the owner explicitly accepts
   the pinned PR SHA. Then remove the `legacy` adapter in a separate change once
   no supported deployment uses `/api/*`.

## Conflict-avoidance rules

| Area | Single owner in this change | Do not |
| --- | --- | --- |
| `src/cli.js` | one `engine` dispatch case + usage lines | re-dispatch legacy `work`/`tasks` through the new client |
| `src/product-commands.js` | untouched | add engine calls there |
| `src/workflow-commands.js` | untouched | rewrite legacy Work |
| `packages/workflow-sdk/*` | marked `LEGACY_ADAPTER` only | add features or change its contract |
| `src/engine-client.js` | only `/v1` transport | learn `/api/*` routes |
| `src/engine-sse.js` | only engine SSE | replace the legacy SSE parser |
| `src/engine-sync.js` | only engine task state | share `tasks.json` with the legacy `src/task-store.js` |
| `.github/workflows/ci.yml` | existing matrix | add a second release pipeline |

## Base branch divergence

At the time of writing, `main` is `c09ab89…` and this branch is 18 commits ahead
and 22 behind: `main` contains the #8–#14 fixes (diagnostics prefix detection,
uninstall launcher removal, private-CI safety, dependabot) while this branch
contains the reconciled release tooling (command registry, completions,
installers, SBOM, task synchronization). The PR must be reviewed against `main`
and rebased/merged by the owner; it is not force-pushed and does not modify
`main` directly. The engine consolidation is additive, so it can also be
cherry-picked onto a fresh `main` branch if the owner prefers to land the release
tooling separately.

## Cross-client acceptance

Both Coderax Web and CoderaxCLI must point at the same engine origin:

1. Web submits Work; CLI `engine tasks` sees it and `engine events` follows it.
2. CLI submits Work; Web reads the task and conversation.
3. A permission requested by the engine is visible in both and decided once.
4. Completion notifications are unread until acknowledged in either client.
5. Closing either client does not stop execution; reopening reconciles the
   terminal state and receipt.

The engine's own e2e suite already asserts the two-client read path; the CLI
acceptance suite asserts submit → replay → second client → notification ack
against the same application.
