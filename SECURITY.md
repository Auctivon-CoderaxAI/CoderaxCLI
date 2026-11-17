# Security

## Credentials

- The token is stored at `~/.coderax/config.json` with mode `0600` when the
  operator runs `config set --token` or the `login` flow saves it; it is never
  written to logs or stdout.
- Writes go to a fresh `0600` temporary file and are atomically renamed over the
  config, so an existing world-readable file never receives the token even
  briefly. A failed rename or an unprotected temp file is an error, not a
  silent success.
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

Every output path is passed through `redact()` or `redactValue()`, which replace
the configured token with a marker. The marker is usually `[REDACTED]`, but it
uses `***` or another collision-safe value when the token shares characters with
`[REDACTED]`. Successful response text is returned in full after redaction;
only error diagnostics are truncated. JSON output stays valid and recursively
redacts both keys and values.

## Timeouts

Every request has a timeout (default 15s, bound to 100–120000 ms) so a hung
deployment cannot block a pipeline indefinitely.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner.
