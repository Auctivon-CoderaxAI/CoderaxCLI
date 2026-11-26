# Security

## Credentials

- The token is stored at `~/.coderax/config.json` with mode `0600` and the
  directory with `0700`. Writes use a fresh `0600` temporary file and an atomic
  rename; a failed rename or unprotected temp file is an error, not a silent
  success.
- A symlinked config path is refused, so a write cannot be redirected to a file
  the operator did not intend to protect.
- `login` validates the token against `/api/user` **before** storing it, and
  only when the deployment reports `role: "ADMIN"` (the instance owner). Any
  other role, a missing endpoint, a 401/403 or a network failure stores
  nothing.
- `whoami` re-checks the owner role. Owner-only mutations (`work submit`,
  `cancel`, `resume`, `retry`, `approve`) check again on every invocation.
- `config show`, `status` and `whoami` report only masked token state
  (`tokenConfigured`, a short mask, source). `describeConfig` omits the token.
- `CODERAX_TOKEN` takes precedence over the file for CI, so short-lived tokens
  need not be written to disk. `logout` clears the stored token and warns when
  the environment token is still active.

## Transport

Remote base URLs must be HTTPS. Plain HTTP is accepted only for loopback
(`localhost`, `127.0.0.1`, `::1`). URLs with embedded credentials or fragments
are rejected. `fetch` uses `redirect: "error"`, so a 3xx cannot forward the
bearer token to another origin. Requests have an idle timeout (default 15s,
bounded 100–120000 ms), not a total deadline that would kill a healthy stream.

## Streaming redaction

Every human and JSON output path redacts the configured token. The streaming
redactor holds back a suffix that could be the beginning of the token, so a
token split across deltas, SSE frames, keys or object values never appears. At
end-of-stream the held suffix is released only after it has been proven not to
be part of the token. Errors are truncated after redaction; successful text is
not truncated.

The token is never placed in URLs, session state, notification commands,
diagnostic output or spawned child environments.

## Retries and writes

Chat `POST /api/work/chat` is never retried: re-sending it would start a second
generation and possibly double-charge the owner. Only idempotent reads and run
stream reconnects are retried, with bounded backoff, and `401`, `403`, `404`,
`CONTRACT_VIOLATION` and `CANCELLED` are never retried. Negotiation uses only
safe GET probes; it never probes a write endpoint.

## Approvals and notifications

Approval defaults to `ask`: an interactive TTY must confirm explicitly.
Non-interactive sessions fail closed (`waiting_approval`, exit `6`) instead of
approving automatically. `allow` and `deny` are explicit operator choices.

`--notify-command` runs a command supplied by the operator with `{id}` and
`{status}` substituted, detached and with stdio ignored. It is never
constructed from server-provided text. Treat it as shell code you chose to run.

## Untrusted server content

Response text, task titles, repository names and error messages are untrusted
data. They are rendered as text, never evaluated, and redacted before display.
The CLI does not execute instructions found in model output or server errors.

## Non-goals

Storing refresh tokens, OIDC device flows, local inference, a local database, a
Docker workload, or acting as a credential broker. Deployment-bound identities
are issued and validated by Coderax; the CLI carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not open
a public issue containing a token, deployment URL or user content.
