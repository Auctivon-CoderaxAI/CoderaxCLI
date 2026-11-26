# Security

## Credentials

- The token is stored at `~/.coderax/config.json` with mode `0600` (override with
  `CODERAX_CONFIG`). It is never written to logs or stdout.
- `login` verifies the token with an owner-only `GET /v1/agents` request before
  storing it. A rejected token is not written.
- Writes go to a fresh `0600` temporary file and are atomically renamed over the
  config, so an existing world-readable file never receives the token even
  briefly. A failed rename or unprotected temp file is an error.
- `config show` reports only `tokenConfigured: true|false`; `status` masks the
  token.
- Environment variables (`CODERAX_TOKEN`) take precedence, so CI can inject a
  short-lived owner token without writing a file.

## Owner-only access

The WorkflowEngine has exactly one principal. The CLI has no signup, membership,
billing or multi-tenant surface, and it does not act as a credential broker.
Deployment-bound machine identities are issued and validated by the engine; the
CLI only carries the resulting owner bearer token.

## Transport

Remote base URLs must be HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1` and `::1`. Credentials embedded in a URL are rejected so a token
cannot end up in shell history as part of the URL.

`fetch` is called with `redirect: "error"`. A deployment that redirects to
another origin produces an error rather than forwarding the bearer token.

## Output hygiene

Every write from a resolved command passes through token redaction, including
engine JSON responses, streamed text, diagnostics and errors. JSON output stays
valid for ordinary bearer tokens. The legacy SSE helper additionally holds back
a suffix that could be the beginning of a token, so a token split across deltas
is redacted as a whole.

## Event stream

Reconnects use the owner token and `after=<lastSeq>`. A 401/403 stops the loop
instead of retrying forever. The CLI never sends the token in the event query.
An event frame that is not JSON is a protocol error and is not rendered as
content.

## Timeouts and limits

Every request has a timeout (default 15s, bound to 100–120000 ms). The event
stream has an independent idle deadline (default 60s, bound to 1000–600000 ms) so
a long-running task cannot block a terminal forever and a dead stream is
detected.

## What the CLI does not do

- It runs no model inference, agent orchestration, builds, tests or engineering
  workload. Those run on the engine host.
- It persists no tasks, conversations, memory or permissions locally. The only
  local state is the token and non-secret defaults.
- It does not download or upload artifacts: contract 1.0.0 exposes metadata only.
- It keeps no cookie jar, telemetry or persistent HTTP agent.

## Reporting

Report suspected vulnerabilities privately to the repository owner.
