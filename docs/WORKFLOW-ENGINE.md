# Authoritative WorkflowEngine integration

This document covers the **separate, authoritative**
[`Auctivon-CoderaxAI/Coderax-WorkflowEngine`](https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine)
backend. It is not the legacy Coderax deployment API (`/api/work/chat`,
`/api/workflows`, `/api/user`) that the top-level commands still support.

## Contract

| Item | Value |
| --- | --- |
| Engine contract version | `1.0.0` |
| API prefix | `/v1` |
| Operations in the published contract | 17 |
| Runtime OpenAPI document | none served |
| Pinned engine commit | `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` |
| Vendored OpenAPI SHA-256 | `4be54dc95fe8b9c00d3521e8e289807716a928bc77c61cc173401303a048cf93` |
| Owner authentication | `Authorization: Bearer <owner token>` |
| Engine package version inspected | `0.1.0` |

The route table lives once in [`src/contract.js`](../src/contract.js), with the
pinned OpenAPI document in [`contracts/`](../contracts). The command registry
in [`src/command-registry.js`](../src/command-registry.js) imports that table;
it does not keep a second copy. The CLI does **not** discover routes at runtime,
and therefore cannot be redirected by a document to another origin.

Top-level dispatch, `coderax --help` and shell completion read the same
registry. `src/cli.js` holds one handler map keyed by the registry's `handler`
values, and `test/command-registry.test.js` fails if a command has no handler, a
handler is unreachable, or help/completion omits a dispatchable command.

| Operation | Method and route | Auth |
| --- | --- | --- |
| `getHealth` | `GET /v1/health` | public |
| `getReadiness` | `GET /v1/ready` | public |
| `listAgents` | `GET /v1/agents` | owner |
| `listModels` | `GET /v1/models` | owner |
| `submitChat` | `POST /v1/chat` | owner |
| `submitWork` | `POST /v1/work` | owner |
| `getTask` | `GET /v1/work/{taskId}` | owner |
| `cancelTask` | `POST /v1/work/{taskId}/cancel` | owner |
| `resumeTask` | `POST /v1/work/{taskId}/resume` | owner |
| `retryTask` | `POST /v1/work/{taskId}/retry` | owner |
| `streamTaskEvents` | `GET /v1/work/{taskId}/events` | owner |
| `listConversations` | `GET /v1/conversations` | owner |
| `getConversation` | `GET /v1/conversations/{conversationId}` | owner |
| `listMemory` | `GET /v1/memory?mode=private\|cloud` | owner |
| `listPermissions` | `GET /v1/work/{taskId}/permissions` | owner |
| `decidePermission` | `POST /v1/work/{taskId}/permissions` | owner |
| `listNotifications` | `GET /v1/notifications` | owner |

## Commands

```sh
coderax engine login            # hidden prompt, stdin, --token-file, or CODERAX_TOKEN
coderax engine logout
coderax engine health
coderax engine ready
coderax engine compat
coderax engine verify
coderax engine agents
coderax engine models
coderax engine chat "hello" --mode cloud
coderax engine work submit "durable objective" --follow
coderax engine work submit "durable objective" --detach
coderax engine task <taskId>
coderax engine tasks                    # durable completions via notifications
coderax engine events <taskId> --once --json
coderax engine cancel <taskId> --reason "owner request"
coderax engine resume <taskId>
coderax engine retry <taskId>
coderax engine conversations
coderax engine conversation <conversationId>
coderax engine memory --mode private
coderax engine permissions <taskId>
coderax engine permissions decide <taskId> <requestId> approve
coderax engine approve <taskId> <requestId>
coderax engine deny <taskId> <requestId> --reason "not this resource"
coderax engine artifacts <taskId>       # metadata only
coderax engine notifications
coderax engine status
coderax engine capabilities --json
```

`engine work submit` accepts either a positional objective or a full
`--data <json>` body. `--data` is parsed and validated locally before the
contract or owner checks, so malformed JSON and empty objectives exit `2`
without a request. The same rule applies to every engine identifier: only a
single identifier of at most 128 characters is accepted, and URL encoding is
applied after validation. Path traversal never reaches a route.

Without `--follow`, Work is submit-only and `--detach` is the explicit alias;
the task continues on the engine. `--follow` consumes the durable SSE stream,
including reconnect/replay, and never re-submits Work. `events` replays from
`?after=<n>`; `--once` stops at the terminal event. `resume`, `retry` and
`cancel` read the current generation when one is required; the client never
guesses a generation. `tasks` is derived from durable notifications because
1.0.0 has no task-list operation; `task <id>` is the authoritative status read.
`artifacts` reports metadata only; upload and download are not implemented by
the contract.

For machine output, `--json` emits one JSON document. The event stream is the
exception: `events --json` emits NDJSON, one compact event per line, followed
by a final summary object. Work progress with `--json` stays off stdout, so the
final document remains parseable.

## Contract and identity checks

Every authenticated engine command performs this order:

1. `GET /v1/health` (public).
2. Validate `contractVersion`: `1.0.x` is accepted; another major or minor is
   `API_VERSION_UNSUPPORTED` (exit `6`); a missing or non-semantic version is
   `API_VERSION_UNVERIFIED` (exit `6`).
3. Require a token, then call `GET /v1/agents`. A `401` is `UNAUTHENTICATED`
   (exit `3`); a `403` is `FORBIDDEN` (exit `3`).
4. Only then call the chosen operation.

The engine exposes no identity endpoint. `engine login` proves the token by
calling an owner-only operation (`/v1/agents`) and only then stores it through
the OS credential store or the `0600` config file; a rejected token is never
written. `engine verify` repeats the proof without changing storage; it does
not invent an email or profile. `engine whoami` is deliberately not exposed as
an identity command.

Transport rules are inherited from `src/client.js`: no redirects, no cookie
jar, no retries, no token in an error string, HTTPS except loopback, and every
route must stay on the configured origin.

## Availability matrix

| Capability | State | Reason |
| --- | --- | --- |
| health, readiness, compat, verify | available | public health + owner `agents` proof |
| agents, models | available | 1.0.0 operations |
| chat | available | `POST /v1/chat` (JSON) |
| Work submit, task read, events, cancel, resume, retry | available | 1.0.0 operations |
| conversations, memory | available | 1.0.0 operations |
| permissions read/decide | available | 1.0.0 operations |
| notifications | available | 1.0.0 list operation |
| task discovery | available | derived from durable notifications; no task-list operation exists |
| task list / execution list | blocked | no list operation in 1.0.0 |
| schedules | blocked | no schedule operation in 1.0.0 |
| artifact metadata | available | paths and digests read from `getTask` results |
| file transfers | blocked | no upload, download or transfer route |
| plugins, tools | blocked | no operation in 1.0.0 |
| projects | blocked | separate Coderax deployment API, not the engine |
| detach | available as `work --detach` | no detach request exists; Work is durable by default |
| cloud browser | blocked | no session operation in 1.0.0 |
| Native Game Studio, Native Gaming Agent | blocked | no operation in 1.0.0 |
| OpenAPI discovery | blocked | the engine serves no document |
| identity | blocked | no identity operation in 1.0.0 |

Blocked commands are declared in the registry with their reason and return exit
`6` **before any HTTP request**. They are not simulated, and no synthetic route
is sent to the engine.

## Verification

The live acceptance test starts the built engine with a local zero-cost
OpenAI-compatible stub and exercises real HTTP:

```sh
CODERAX_ENGINE_DIR=/path/to/Coderax-WorkflowEngine npm run test:engine
```

It covers health and contract reporting, unauthenticated and wrong-token
refusal, agents/models discovery, chat, durable Work to `completed`, task
read and notification-derived discovery, SSE event replay, artifact metadata,
conversations, memory, permissions, notifications, status, compat and verify,
and a blocked schedule command pointed at an unreachable origin (proving
fail-closed behavior). The test is skipped when `CODERAX_ENGINE_DIR` is not
set; the regular suite remains dependency-free.

## Consolidation boundaries

This branch is the integration point for two existing workstreams:

- **PR #6** (`327d3ea`): release, owner authentication and OS credential
  storage, durable synchronization, installers, 0.3.0 packaging and 3-OS CI.
- **`feat/engine-thin-client-v1`** (`0cd85bf`): the pinned engine contract,
  OpenAPI provenance, validated HTTP client, SSE decoder, event assembler and
  command handlers. Those modules are adopted here as `src/contract.js`,
  `src/engine.js`, `src/sse.js`, `src/events.js`, `src/engine-surface.js`,
  `contracts/` and `test/engine-contract.test.js`. Its separate top-level
  `src/cli.js` was not merged; the registry-driven `engine` adapter is this
  branch's single engine command table.

This branch owns the integration files `src/command-registry.js`,
`src/engine-client.js`, `src/engine-commands.js`, the registry-driven top-level
and `engine` dispatch in `src/cli.js`, and the engine job in
`.github/workflows/ci.yml`. `src/engine-commands.js` is deliberately a thin
adapter: contract/owner preflight, identifier validation, secure login/logout,
capability reporting and output sanitization. It does not reimplement the
adopted Chat, Work, task, permission or memory handlers. The engine-core and
handler files remain owned by the `feat/engine-thin-client-v1` workstream;
changes there should be integrated, not re-derived.

Remaining work is dependency-linked, not merged blindly:

| Work | Branch / PR | Boundary |
| --- | --- | --- |
| Interactive terminal and slash commands | `feat/terminal-client-completion` (`b22158b`) | Must import `command-registry.js`; it must not add a second command table. Its interactive/session modules are not duplicated here. |
| Capability routes (`/v1/capabilities/*`) | `feat/workflow-engine-capabilities` (`5322865`) | Targets the open 1.1.0 contract, not engine main; blocked until 1.1.0 is authoritative. |
| 1.1.0 handshake/artifacts/permissions | WorkflowEngine PR #7 (open) | Sibling engine PRs (#2–#10) define overlapping 1.1.0 surfaces; wait for one authoritative contract. |
| Schedules | WorkflowEngine PR #9 (open) | Engine main has no schedule route; the CLI stays blocked. |
| Durable recovery | WorkflowEngine PR #10 (open) | Reconnect/replay is already handled; adopting new recovery semantics requires the merged contract. |
| Release/SDK packaging | PR #6 (`327d3ea`) | Merged into this branch; the SDK is still `private: true` and not installable. |
| PR #5 / #4 | superseded / related | Release work is consolidated in PR #6; the SSE fixture fix is already in this branch's base. |

Only the engine command surface is claimed here. The legacy top-level
`chat`, `work`, `tasks`, `runs` and approval commands remain PR #6's handlers
for the separate Coderax deployment, so existing owner access and data are
preserved. `coderax engine ...` is the unambiguous path to the authoritative
engine.
