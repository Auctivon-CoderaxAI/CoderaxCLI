# Security

## Credentials

- The token is stored at `~/.coderax/config.json` with mode `0600` and only when
  the operator runs `config set --token`; it is never written to logs or stdout.
- `config show` reports only `tokenConfigured: true|false`.
- `describeConfig` deliberately omits the token, and tests assert the string never
  appears in its output.
- Environment variables (`CODERAX_TOKEN`) take precedence, so CI can inject a
  short-lived token without writing a file.

## Transport

Remote base URLs must be HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1`, matching the Coderax desktop client's policy. Credentials
embedded in a URL are rejected so a token cannot end up in shell history as part
of the URL.

## Redirects

`fetch` is called with `redirect: "error"`. A deployment that redirects to another
origin therefore produces an error rather than leaking the bearer token to a third
party.

## Output hygiene

Every error string is passed through `redact()`, which replaces the configured
token with `[REDACTED]`. This covers the case where a server echoes the token in a
validation message. Response text is truncated before it is shown.

## Timeouts

Every request has a timeout (default 15s, bound to 100–120000 ms) so a hung
deployment cannot block a pipeline indefinitely.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner.
