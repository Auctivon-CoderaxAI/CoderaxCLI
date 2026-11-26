# Architecture

`coderax` is a thin terminal client. It renders cloud execution; it never
performs it.

```
argv
  │
  ▼
src/cli.js ── parse ── preflight ── dispatch ── exit code
  │                                      │
  │                                      ├─ interactive/app.js
  │                                      ├─ commands/work.js ── engine/{client,submit,stream}
  │                                      ├─ commands/workflow.js ── workflow/{catalog,environment}
  │                                      ├─ commands/chat.js ── engine/client.js
  │                                      ├─ commands/{agents,models,...} ── engine/client.js
  │                                      └─ commands/deploy.js ── legacy client.js
  │
  └─ runtime.js ── config.js ── credentials.js
                ├─ state.js   (durable local journal)
                └─ redact.js  (all output paths)
```

## Layers

| Module | Responsibility |
| --- | --- |
| `src/cli.js` | Argument parsing, preflight, command dispatch, help, exit-code mapping |
| `src/runtime.js` | Composition root: config, token provider, engine client, journal, output, redaction |
| `src/config.js` | URL/timeout validation, config precedence, atomic private config writes |
| `src/credentials.js` | Keychain / DPAPI / Secret Service / fallback storage, helper execution |
| `src/state.js` | Lock-protected local journal: active conversations, tasks, cursors, history |
| `src/engine/contract.js` | Strict dependency-free contract mirror and validators, with the pinned engine OpenAPI artifact in `contracts/` |
| `src/engine/client.js` | `/v1` requests, Problem mapping, contract negotiation, auth refresh, capability checks |
| `src/engine/stream.js` | SSE cursor replay, reconnect, dedupe, gap detection, final status reconciliation |
| `src/engine/submit.js` | At-most-once Work submission and the idempotency ledger |
| `src/commands/*` | Chat, Work, workflow, auth, config, sessions, notifications, permissions, completion, deploy |
| `src/workflow/catalog.js` | Engineering kinds, delivery-operation mapping, branch/repository/task validation, delivery policy |
| `src/workflow/environment.js` | Contract, readiness, owner-session and agent-capability verification; no trust from server flags |
| `src/interactive/app.js` | Readline shell, slash commands, prompt state, approvals, detachment |
| `src/ui/*` | ANSI, incremental Markdown/code rendering, Spinner, PromptSession, tables, presenter |
| `src/work/templates.js` | Cloud-work objectives and their capability requirements |
| `src/product-*`, `src/discover.js`, `src/client.js` | Legacy deployment/OpenAPI surface |

## Cloud execution boundary

The CLI has no inference client, model runtime, sandbox, build runner or local
agent. `chat`, `work` and every engineering template serialize an objective and
send it to the WorkflowEngine. The only local processes are the OS credential
helper (`security`, `secret-tool`, `powershell`) and an explicitly configured
token-refresh command.

## Work flow

1. Resolve config, owner token, engine URL and selected agent.
2. Fetch health, negotiate `contractVersion`, fetch agents/models.
3. Validate the agent's `tools`, `durable`, `resume` and `modelSelection`
   capabilities before submitting a template or detaching.
4. Create or reuse an idempotency key; persist an `inflight` ledger entry.
5. `POST /v1/work`; a definite 4xx rejection clears the attempt, an ambiguous
   network/timeout outcome becomes `SUBMISSION_UNCERTAIN`.
6. Stream `/v1/work/{taskId}/events?after=<seq>` with `Last-Event-ID`, or read
   `eventsPath` when the engine supplies it.
7. Persist event sequence and task state after every applied event; render
   text, tool calls, file edits, steps, usage and approvals.
8. On disconnect, reconnect from the persisted cursor. On a terminal event or
   exhausted reconnect, fetch `GET /v1/work/{taskId}` and use the authoritative
   state and artifacts.
9. Exit with the task's state and the shared exit-code table.

## Engineering control plane

`coderax workflow` is a mapping layer, not a second engine. `catalog.js` declares
ten engineering kinds as objectives for the published `POST /v1/work`
operation, plus the delivery operations the CLI needs but contract `1.0.0` does
not publish. It contains no planner, scheduler, task state machine or
permission policy.

`environment.js` proves the exact contract, engine readiness, an
owner-authenticated `GET /v1/agents` call and the selected agent's capabilities
before submission. It reports deployment and repository identity as
unsupported, because the contract publishes neither. A server-supplied
`verified` or `authorized` field is not read; the strict contract validator
rejects unknown fields.

Delivery actions (`diff`, `branch`, `commit`, `pr`, `ci`, `remediate`) and
`repos`/`pause` have no published operation and therefore send nothing. They
exit `6` with the required operation name instead of inventing a route or
simulating a result. Implemented task controls (`status`, `watch`, `attach`,
`takeover`, `cancel`, `resume`, `retry`) reuse the durable Work machinery and
the same local journal.

## Local durability

`state.json` lives beside the config, is written atomically under a lock, and
holds only non-secret data: active mode and conversations, selected agent/model,
task cursors/status, a bounded submission ledger, seen notification keys and
per-mode input history. Cross-process updates re-read under the lock before
writing, so two terminals do not overwrite each other's active conversation or
submission ledger.

## Authentication

Token precedence: explicit one-shot flag, `CODERAX_ENGINE_TOKEN`,
`CODERAX_TOKEN`, OS credential store, legacy config token. The legacy value is
returned so `login` can migrate it and remove it from disk.

On `401`, the engine client invokes the token provider once. The provider can
run the configured refresh helper (explicit argv, no shell) or reload a newly
stored token. If neither produces a different token, the request fails with
`AUTH_REFRESH_UNAVAILABLE`; it never retries indefinitely.

## Output and errors

`--json` produces one document; `--ndjson` produces one event per line plus a
final result. Human progress is suppressed or sent to stderr in these modes.
All text passes through the redactor, which knows the current token and any
`CODERAX_ENGINE_TOKEN`/`CODERAX_TOKEN` environment secret. Errors are typed and
mapped by `src/errors.js`; the exit code is part of the public interface.

## Deliberate constraints

- No local workflow engine or fallback execution path.
- No simulated delivery: an operation the contract does not publish is
  reported unavailable, never approximated with a Work objective or a local
  command.
- No server flag is treated as trust or authorization; the engine decides.
- No provider API keys read, stored, logged or inherited.
- No anonymous owner operations.
- No redirects, cookies, telemetry or background daemon.
- No automatic retry of an ambiguous Work submission.
- No registry publication; releases are GitHub archives with checksums.
- The legacy OpenAPI deployment commands remain separate from `/v1` engine
  commands so a deployment URL cannot be mistaken for a WorkflowEngine.
