# CLI ↔ deployment contract

Version: CLI `0.3.0`, API major `1`. Shapes were read from
`Auctivon-CoderaxAI/Coderax` at `main` (`a5d237b0`). The client-side checks live
in `test/contract.test.js`; backend gaps are tracked in
[`BACKEND-DEFECTS.md`](../BACKEND-DEFECTS.md).

## Authentication and ownership

Every request carries `Authorization: Bearer <token>`. The CLI never forwards
cookies and adds no headers except `accept`, `authorization`,
`content-type` on bodies, `last-event-id` on reconnects, and
`x-coderax-api-version: 1`.

`login` calls `GET /api/user` and accepts the token only when the returned
`role` is exactly `ADMIN` (`SystemRoles.ADMIN`). Nothing is persisted
otherwise. `whoami` repeats the check; owner-only mutations (`work submit`,
`cancel`, `resume`, `retry`, `approve`) call `requireOwner()` again so a token
that lost the role cannot mutate.

A token is never accepted in argv. `login` reads it from a hidden terminal
prompt, stdin, a `0600` `--token-file`, or `CODERAX_TOKEN`; `--token` exits `2`.
The installer never handles credentials at all.

| Condition | Code | Exit |
| --- | --- | --- |
| no token | `UNAUTHENTICATED` | 3 |
| HTTP 401/403 | `UNAUTHENTICATED` / `FORBIDDEN` | 3 |
| role is not `ADMIN` | `FORBIDDEN` | 3 |
| `/api/user` missing | `OWNER_UNVERIFIABLE` | 6 |

## API version and capabilities

The deployment publishes no metadata endpoint. The client therefore sends
`x-coderax-api-version: 1`, accepts a server response header when present, and
otherwise records `API_VERSION_UNVERIFIED`. A different major is
`API_VERSION_UNSUPPORTED` (exit `6`). `--strict` turns either warning into a
failure before the operation.

Capabilities are declared in metadata when available; otherwise two safe GET
probes (`/api/work/tasks`, `/api/workflows`) fill the gaps. An undeclared
capability is never replaced by a guessed route. The CLI reports
`CAPABILITY_INFERRED`, `CAPABILITY_DEGRADED` (503), or
`CAPABILITY_UNAVAILABLE` (exit `6`).

Deployment compatibility has a second axis: the version published in the
OpenAPI document (`info.version`). The CLI supports `>=0.8.8 <1.0.0`, the
release the shapes above were read from. `coderax compat` reports the API axis
and the deployment axis separately, and treats an unreported version as unknown,
never as compatible. `/health` is plain text on the reference deployment, so it
is not a version source.

## Routes

| Operation | Route | Shape |
| --- | --- | --- |
| identity | `GET /api/user` | `{ email, role, ... }` |
| chat / Work | `POST /api/work/chat` | body `{text, mode, endpoint, conversationId?, parentMessageId?, agent_id?, model?, promptPrefix?}`; SSE |
| Work models | `GET /api/work/models` | `{ models: [...] }` |
| Work agents | `GET /api/work/agents` | `{ agents: [...] }` |
| readiness | `GET /api/work/readiness` | JSON |
| Work history | `GET /api/work/tasks` | `{ tasks: [...] }` |
| Work task | `GET /api/work/tasks/:conversationId` | `{ task: {...} }` |
| cancel Work task | `POST /api/work/tasks/:conversationId/cancel` | JSON |
| workflows | `GET /api/workflows` | `{ workflows: [...] }` |
| runs per workflow | `GET /api/workflows/:id/runs` | `{ runs: [...] }` |
| start build | `POST /api/workflows/builds` | body `{request, mode, agentId, repository:{owner,name,baseRef?}, workspace}` |
| run | `GET /api/workflows/runs/:runId` | `{ run: {...} }` |
| run stream | `GET /api/workflows/runs/:runId/stream` | SSE `data: {"run": ...}` |
| approve | `POST /api/workflows/runs/:runId/approve` | body `{stepIndex}` |
| pause / resume / cancel | `POST /api/workflows/runs/:runId/{pause,resume,cancel}` | JSON |
| repository inventory | `GET /api/repos` | absent on the reference deployment |

There is **no global run list**. `coderax runs` therefore requires
`--workflow <id>`; `coderax run <runId>` works with a known id.

## Chat stream

The reference deployment emits cumulative text snapshots, not deltas. The CLI
accepts all three observed shapes:

```text
data: {"type":"text","text":"<cumulative>","index":0}
data: {"message":true,"text":"<cumulative>"}
data: {"final":true,"responseMessage":{"text":"...","messageId":"...","conversationId":"..."}}
data: [DONE]
```

The final frame is authoritative. The CLI rejects a `200 application/json`
response because the route is a streaming contract (`CONTRACT_VIOLATION`,
exit `7`). Response text is redacted before display and the token is never
logged.

Because frames have no `id:`, the CLI emits `CURSOR_UNSUPPORTED`. It never
retries the POST: a retry would create a second generation. An interrupted
stream is `STREAM_INCOMPLETE` (exit `7`) and reports the conversation id so the
turn can be followed through the durable Work API.

When a deployment does emit ids, `EventSequencer` de-duplicates replay,
buffers out-of-order frames, and reports `DUPLICATE_EVENT` /
`OUT_OF_ORDER_EVENT`.

## Run stream and reconnection

The reference deployment polls the run record and emits a full snapshot only
when it changes. It has no `id:` field and ignores `Last-Event-ID`.

The CLI therefore:

- reconnects with `last-event-id` when it has seen an id;
- re-reads a full snapshot on every reconnect (idempotent);
- reports `CURSOR_IGNORED` if the deployment replays an id already seen;
- reports `CURSOR_UNSUPPORTED` when snapshots carry no ids;
- retries only transport/5xx/`STREAM_INCOMPLETE` failures, with bounded
  exponential backoff (`--max-retries`, default 3);
- never retries `401`, `403`, `404`, `CONTRACT_VIOLATION`, `CANCELLED`, or an
  unknown run status.

A terminal run returns `0` (`completed`), `1` (`failed`), or `0`
(`cancelled`). A run left in `waiting_approval` with no interactive approval
returns `6`. A run in `paused` is still monitorable and returns `0` when the
stream ends without failure.

Ctrl-C aborts the local stream and leaves the server-side run alive. The
command prints the run id and conversation id and exits `130`.
`--cancel-on-interrupt` explicitly cancels instead. `--notify` rings the
terminal bell; `--notify-command` spawns a detached operator command with
`{id}` and `{status}` substituted.

## Approval

Approval policies are `ask` (default), `allow`, and `deny`. `ask` requires an
interactive TTY and a confirmation; non-interactive sessions fail closed
instead of approving automatically. An approval request sends the exact
`stepIndex` reported by the run.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success, including completed and paused runs |
| `1` | failed run or other operational failure |
| `2` | usage or configuration error |
| `3` | unauthenticated, forbidden, or not the owner |
| `4` | network failure or timeout |
| `5` | not found |
| `6` | capability or API version unavailable (fail closed) |
| `7` | contract violation, including an incomplete stream |
| `130` | cancelled or detached locally |

## Interactive terminal transport (provisional)

The terminal consumes a facade with a deliberately small surface:

```js
getCapabilities() -> {
  contractVersion, contractVerified, stream, work, tools, attachments,
  conversations, permissions, verifiedPermissions, models, agents,
  modelSelection, agentSelection
}
streamMessage({ mode, text, model, agent, conversationId, attachments,
                signal, onEvent })
respondPermission(payload)
listModels(), listAgents(), listConversations(), close()
```

Events are `delta`, `replace`, `final`, `tool`, `progress`, `permission` and
`conversation`. The presentation layer does not route models or run workflows;
it only renders these events and passes selections through.

The shared `packages/workflow-sdk` transport is the default for both the terminal
and non-interactive commands. `CODERAX_SDK=legacy` selects the bounded
compatibility adapter; it is not the default. `CODERAX_SDK=canonical` requires
`contractVersion` `coderax-sdk/1`, `contractVerified: true` and streaming
support; a mismatch exits with `SDK_CONTRACT_MISMATCH` rather than falling back
silently. `CODERAX_SDK=auto` falls back to legacy until that handshake succeeds.
This contract is provisional until the gateway and WorkflowEngine owners verify
it end to end.

## Permission approval (provisional)

A permission request is actionable only when all of these are present:

- `serverIssued: true`, received on the authenticated SSE/SDK channel
- `requestId` issued by the server
- `executionId` identifying the engine execution
- `action` from the allowed set (`read_file`, `write_file`, `delete_file`,
  `list_directory`, `run_command`, `network`, `send_files`, `use_tool`)
- `resource` that canonicalises to an absolute path, URL or exact command
- optional `expiresAt` and `resourceHash`; a supplied hash must match

The response is `{ requestId, executionId, action, resourceHash, decision,
  decidedAt }`. Session approval applies to that exact tuple only. The legacy
  transport declares `permissions: false` and fails closed.

## Tests that pin this contract

`test/contract.test.js` stubs the deployment and asserts, among others:

- JSON `200` where SSE is required is rejected;
- a `2.0` API header is rejected;
- duplicate/out-of-order frames render once and in order;
- chat without ids reports `CURSOR_UNSUPPORTED`;
- reconnect sends `Last-Event-ID`, deduplicates replay, and reports
  `CURSOR_IGNORED`;
- a server restart with a snapshot-only stream converges;
- an interrupted chat POST is never retried;
- failed runs exit `1`, suspended runs are reported distinctly, and
  `waiting_approval` fails closed;
- expired credentials exit `3` without retrying;
- an unadvertised capability exits `6` without calling the guessed route.

## Canonical WorkflowEngine `/v1` contract

The authoritative engine contract is
`Auctivon-CoderaxAI/Coderax-WorkflowEngine`. Its generated `openapi.json` is
vendored at `contracts/workflow-engine-1.0.0.openapi.json` with provenance in
[`contracts/PROVENANCE.md`](../contracts/PROVENANCE.md). The implementation
lives inside the one shared SDK at `packages/workflow-sdk/src/v1/`; there is no
second mirror in `src/`.

| Concern | Behaviour |
| --- | --- |
| Version | Accepts any server reporting major `1`; a newer minor records `CONTRACT_MINOR_NEWER`; another major is `CONTRACT_UNSUPPORTED`. |
| Validation | Every response and execution event is checked with strict, exact-key rules. A drift is `CONTRACT_VIOLATION`, never a plausible wrong value. |
| Chat | `POST /v1/chat` accepts a JSON `ChatReply` or an SSE reply that ends in one; an SSE reply without a final `ChatReply` is `STREAM_INCOMPLETE`. |
| Events | `GET /v1/work/{taskId}/events?after=<seq>` plus `Last-Event-ID`. A duplicate `eventId` is dropped; `seq <= last` is a replay; a gap reconnects from the cursor; more than three gaps is `EVENT_GAP`. |
| Task state | `GET /v1/work/{taskId}` is authoritative. A closed stream is never read as completion. |
| Submission | One idempotency key per submission, written to a private ledger before transmission. An ambiguous outcome is `SUBMISSION_UNCERTAIN` (exit `9`) and is never retried automatically. |
| Approvals | Only a server-issued `approval.required` event produces a prompt; a decision is sent to `POST /v1/work/{taskId}/permissions` with its `requestId`. |
| Attachments | Refused with `CAPABILITY_UNAVAILABLE`; `/v1` publishes no upload operation. |

`CODERAX_SDK=v1` selects this transport and fails closed. `workflow` and
`legacy` remain explicit migration modes; `auto` and `canonical` are unchanged.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | unclassified failure |
| 2 | usage |
| 3 | unauthenticated / forbidden |
| 4 | network or timeout |
| 5 | not found |
| 6 | unavailable / unsupported capability |
| 7 | contract violation |
| 8 | approval required and not granted |
| 9 | submission uncertain (do not blindly resubmit) |
| 10 | conflict or busy |
| 130 | cancelled |

Engine-side defects found while implementing this contract are recorded in
[`BACKEND-DEFECTS.md`](../BACKEND-DEFECTS.md) (W1 chat content type, W2 Work
idempotency).

## Direct engine task tools

`coderax engine` uses the [pinned WorkflowEngine contract](../contracts/PROVENANCE.md).
The Chat operation returns one JSON reply, as declared by the local
[OpenAPI overlay](../contracts/workflow-engine-chat.overlay.json).
Work returns a durable task ID; event streams replay with the sequence cursor,
deduplicate frames and reconnect with a resettable idle deadline. Interrupting
a follow detaches the client. Use `coderax engine cancel <taskId>` to request
cancellation on the engine. Work status provides artifact metadata; this
contract does not publish file transfer routes. The task list is derived from
notifications because the engine does not expose a task list operation.
