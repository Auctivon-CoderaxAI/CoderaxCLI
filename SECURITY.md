# Security

## Threat model

The assets are the Coderax owner token, provider credentials held by the cloud
engine, and the integrity of cloud Work tasks. The CLI runs on an owner's
machine; the WorkflowEngine is remote. The CLI is not a sandbox and does not
execute untrusted repository code.

## Owner authentication

Every engine operation except the contract-public `/v1/health` and `/v1/ready`
requires `Authorization: Bearer <owner token>`. The CLI has no anonymous mode,
no implicit shared token, and no unauthenticated fallback. The repository being
public does not grant API access.

`login` validates the token against `/v1/health` and `/v1/agents` before storing
it. A token must be 16–16,384 characters without control characters. A rejected
token is never saved.

## Credential storage

| Platform | Backend |
| --- | --- |
| macOS | Keychain generic password, service `coderax-cli`, account `owner` |
| Windows | DPAPI-encrypted `credential.dpapi`, current-user scope |
| Linux | Secret Service item via `secret-tool` |
| Fallback | `credentials.json` with mode `0600` in a `0700` directory |

The fallback is used only when the requested OS backend is unavailable or when
`--credential-store file` is explicitly selected. `coderax status` and `doctor`
report the actual backend and any fallback warning. `config.json` never contains
the token; `login` removes a legacy token from it.

Environment variables (`CODERAX_ENGINE_TOKEN`, `CODERAX_TOKEN`) are supported
for short-lived automation and intentionally take precedence. They are visible
to the process environment by design; unset them after use. `logout` leaves
them untouched and warns.

## Child processes

Credential and refresh helpers are spawned with:

- an explicit allowlisted environment (no owner token, no provider keys, no
  arbitrary inherited credentials);
- `shell: false` and an argv array;
- bounded stdout/stderr and a timeout;
- the token on stdin, never in argv.

The only child processes are the platform credential helper and an explicitly
configured refresh command. The CLI does not spawn builds, tests, model runtimes,
servers, Git or a shell.

## Transport

Remote URLs must be HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1` and `::1`. URLs with embedded credentials, query strings or
fragments are rejected. `fetch` uses `redirect: "error"` so a bearer token is
never forwarded to another origin. Responses are size-bounded and validated
against the contract before use.

## Output hygiene

Every output path passes through `src/redact.js`, including error text, JSON
values, Markdown and streamed deltas. It redacts the current bearer token and
any credential-shaped environment value this process can see. Redaction markers
are chosen not to collide with a secret. Tokens are never included in `--json`/`--ndjson`
results; `config show` reports only `tokenConfigured` and a masked prefix/suffix.

## Permissions and approvals

Work defaults to `requireApproval: true`. An approval prompt names the tool,
scope, resource, request id and description; the default answer is deny. The
decision is sent to `/v1/work/{taskId}/permissions` and is scoped to that one
request. `--approve-all` and `--deny-all` are opt-in non-interactive policies.
A non-interactive run without a policy exits `8` rather than silently granting
or hanging.

## Workflow authorization and delivery

`coderax workflow` uses the same owner bearer token and the same server-side
authorization as `work`. Before submitting, it verifies the exact contract,
engine readiness, an owner-authenticated `GET /v1/agents` call and the selected
agent's capabilities. It does not treat a server-supplied `verified` or
`authorized` field as trust; the strict contract validators reject unknown
fields.

A local `--confirm` flag gates a delivery mutation but is not authorization.
`--allow-production` and `--allow-destructive` record local intent only and
cannot unlock a command or override an engine refusal. A `401`/`403` from the
engine is surfaced with exit `3` and is never retried as a new write.

Delivery is PR-only. There is no direct-push, force-push or merge command, and
those switches are rejected as unknown options. Protected branches can be a
pull-request base but never a head. Branch names and repository references are
validated before any request, and task ids cannot contain path separators.

Contract `1.0.0` publishes no repository, diff, branch, commit, pull-request,
CI, pause or delivery-remediation operation. Those commands exit `6` without
sending a request. The CLI does not invent a route, execute Git locally or
simulate a successful delivery.

## Cloud-only execution

The CLI never runs model inference, a local agent, repository builds, tests,
databases or development servers. Repository inspection, code changes, test
execution, diffs, PR preparation, review remediation and CI monitoring are
Work objectives executed by the WorkflowEngine in its cloud workspace. If the
engine reports that its agent lacks `tools`, the command fails explicitly with
`CAPABILITY_UNSUPPORTED`; it does not emulate the workflow locally.

## Idempotency and integrity

Work submission uses a client-generated key persisted before the request. A
definite HTTP rejection is retried only by an explicit user action; an ambiguous
network failure is recorded as `SUBMISSION_UNCERTAIN` and reconciled with
`coderax work resolve`. This prevents duplicate cloud tasks and duplicate
spending.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not open
a public issue containing a token, a provider key, a private repository path or
engine response data.
