# Cloud engineering control plane

`coderax workflow` is the engineering access and control surface for Coderax
Native. It discovers the repository the engine mounted, submits an engineering
objective, follows the durable task, and hands back the evidence. It never
plans, builds, tests or edits code on the owner's computer.

The CLI is a thin client over the authoritative WorkflowEngine contract. There
is no second workflow engine, task state machine, planner, permission policy or
orchestration layer in this repository.

## Commands

```sh
coderax workflow environments
coderax workflow kinds
coderax workflow repos                     # unavailable in contract 1.0.0
coderax workflow run <kind> "<request>" [--repo owner/name] [--detach]
coderax workflow status <taskId>
coderax workflow watch <taskId> [--after <seq>]
coderax workflow attach <taskId>
coderax workflow takeover <taskId>
coderax workflow cancel <taskId> [--reason <text>]
coderax workflow resume <taskId>
coderax workflow retry <taskId>
coderax workflow pause <taskId>            # unavailable in contract 1.0.0
coderax workflow diff <taskId>             # unavailable in contract 1.0.0
coderax workflow ci <taskId>               # unavailable in contract 1.0.0
coderax workflow remediate <taskId>        # unavailable in contract 1.0.0
coderax workflow branch <name>             # unavailable in contract 1.0.0
coderax workflow commit                    # unavailable in contract 1.0.0
coderax workflow pr                        # unavailable in contract 1.0.0
```

Every command accepts the global `--json`, `--ndjson`, `--agent`, `--model`,
`--detach`, `--timeout` and `--conversation` options where they make sense.
Invalid options are rejected before a request is sent.

## Engineering kinds

Each kind is a declarative objective sent to the published `POST /v1/work`
operation. The engine's agent decides how to execute it. Every kind requires
the selected agent to publish `tools: true`.

At the pinned engine commit `808dfd3`, Coderax Native publishes
`tools: false`. Engineering kinds therefore refuse with
`CAPABILITY_UNSUPPORTED` (`7`) until the engine configures and publishes a
tool-capable agent (OpenCode advertises `tools: true` when its transport is
available). `workflow environments` and `workflow kinds` report the selected
agent's tools flag and name any tool-capable agent. The CLI never substitutes
an agent and never runs a coding task locally.

| Kind | Cloud action | Writes |
| --- | --- | --- |
| `inspect` | Repository structure, build/test entry points, CI and risks | no |
| `architecture` | Module boundaries, data flow, integration points and risks | no |
| `generate` | Implement a scoped feature and run focused verification | yes |
| `fix` | Reproduce a defect, fix the root cause, add a regression test | yes |
| `refactor` | Behaviour-preserving restructuring verified by tests | yes |
| `debug` | Evidence-led diagnosis and a minimal verified fix | yes |
| `tests` | Add focused tests for the requested behaviour | yes |
| `test-run` | Run the project's tests and report exact results | no |
| `review` | Review the current change with severity and file/line references | no |
| `audit` | Defensive security and dependency audit | no |

The objective always instructs the agent to work only in its isolated cloud
workspace, never push or merge, and report the commands it actually ran.
`--repo owner/name` is context for the objective, not a verified repository
selection (see below).

## Delivery operations

Delivery is intentionally stricter than a Work objective. Branch creation,
commit preparation, pull-request creation, CI status and review remediation
require dedicated engine operations. Contract `1.0.0` publishes none of them,
so the CLI reports `unavailable`, exits `6`, sends no request and does not
simulate a result.

| CLI action | Required engine operation | Mutation | Contract 1.0.0 |
| --- | --- | --- | --- |
| `diff` | `getTaskDiff` | no | not published |
| `branch` | `createBranch` | yes | not published |
| `commit` | `prepareCommit` | yes | not published |
| `pr` | `createPullRequest` | yes | not published |
| `ci` | `getCiStatus` | no | not published |
| `remediate` | `remediateReviewFindings` | yes | not published |
| `repos` | `listRepositories` | no | not published |
| `pause` | `pauseTask` | yes | not published |

These are operation names, not routes. The CLI assumes no path, method or
payload for them. When the engine publishes the operation in a reviewed
contract, the mapping is added here and in `src/workflow/catalog.js` together
with the contract version bump; until then the refusal is the correct result.

`resume`, `retry`, `cancel`, `status`, `watch`, `attach` and `takeover` are
implemented because the contract publishes those operations.

## Environment verification

`workflow environments` proves all of the following before reporting ready:

1. The configured origin served a contract this CLI understands (`/v1/health`).
2. The engine is healthy and `/v1/ready` reports ready.
3. The owner bearer token is accepted for an owner-only read (`GET /v1/agents`).
4. The selected agent is published by that engine and is available.

It deliberately does **not** claim:

- a deployment identifier, because contract `1.0.0` publishes none;
- repository identity, because contract `1.0.0` publishes no repository
  operation or immutable repository id;
- infrastructure trust from a server-supplied `verified` or `authorized` flag.
  The strict contract validators reject unknown fields, and neither flag is
  read. A response that adds them is a contract error (`7`), not a grant.

The result therefore reports `trust: "unverified"` and explains each gap.
Server-side authorization remains authoritative for every operation.

## Authorization and delivery policy

- Every non-public request carries the owner bearer token. There is no
  anonymous owner access and no service-account fallback.
- The engine decides whether the authenticated owner may write. A `401` or
  `403` exits `3` and is never retried as a new Write.
- `--confirm` gates a delivery mutation locally, but it is not authorization.
  A backend refusal is surfaced unchanged.
- `--allow-production` and `--allow-destructive` are recorded as local intent
  only. They cannot unlock a command, bypass server approval, or change an
  engine decision.
- Pull requests are draft by default, never merged by the CLI, and never
  force-pushed. There is no direct-push command, no force flag and no merge
  flag; all three are unknown options (`2`).
- Protected branches (`main`, `master`, `trunk`, `develop`, `development`,
  `staging`, `production`, `prod`, `gh-pages`, `release/*`, `hotfix/*`) can be
  a pull-request base but never a head. Branch names are validated against a
  conservative `git check-ref-format` subset before any request.
- Repository references are plain `owner/name`; traversal and path-like values
  are rejected. Immutable repository ids will be required when the engine
  publishes them.
- Local flags, previews and echoed policies never substitute for engine
  authorization.

## Durable tasks

Engineering tasks use the same durable Work machinery as `coderax work`:

- at-most-once submission with a persisted idempotency ledger;
- authoritative task status from `GET /v1/work/{taskId}`;
- SSE replay from the last acknowledged sequence, with deduplication, gap
  detection and bounded reconnect;
- `--detach` returns after `202`; the task keeps running in the cloud;
- `workflow attach` and `workflow takeover` reattach from the persisted
  cursor; `status` works from a fresh terminal with an explicit id;
- approvals are requested by the engine and decided through
  `POST /v1/work/{taskId}/permissions`; a denied or failed decision stops the
  local wait and never fabricates approval;
- completion notifications remain available through `coderax notifications`.

The local journal stores only non-secret control data (task cursor, state,
conversation, submission ledger). The engine remains authoritative.

## Interactive terminal

`/workflow <kind> <request>` submits an engineering kind from the interactive
prompt without memorizing the full command surface. Plain text in Work mode is
still a natural-language engineering objective. `/run <template>` remains the
shorter preset path.

## Backend integration status

The control plane is verified two ways:

- A real HTTP fixture implements the published contract, including
authentication, readiness, task submission, streaming, permissions,
cancellation and a successful engineering run with a tool-capable agent.
- The pinned authoritative WorkflowEngine commit is built and exercised
locally and in CI. The real-engine tests prove contract negotiation, owner
authentication, a rejected unauthenticated workflow write, successful `work`
lifecycle and the capability refusal for the Native agent's `tools: false`.

No live deployment URL or owner token is committed to this repository, so a
production engineering run is not claimed. The remaining integration work
belongs to the engine, not the CLI:

1. Publish repository discovery with immutable repository ids and an
   authorization check per repository.
2. Publish branch, commit, pull-request, diff and CI operations with explicit
   owner authorization and protected-branch enforcement.
3. Publish a deployment identity and a signed handshake so a client can
   distinguish two deployments serving the same contract.
4. Publish pause/takeover semantics if they differ from cancel/resume.

Until then the CLI refuses those operations rather than inventing a contract.
