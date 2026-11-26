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

## File transfer

- Uploads are limited to regular files, are non-empty, and are checked against
  both the extension and the file's magic bytes before any bytes leave the
  machine. Symbolic links and directories are refused. The accepted MIME types,
  upload limit and every capability option come from the engine registry.
- The exact multipart file bytes are hashed with SHA-256 and sent with
  `x-content-sha256`. The engine must echo the same digest and byte count; a
  mismatch aborts before capability execution.
- Downloads require a published SHA-256 digest. The body is hashed while being
  written to a fresh file or a `0600` temporary file, then verified against the
  digest and byte count. On mismatch or cancellation the partial data is deleted.
- A destination is never overwritten implicitly. Existing files require
  `--force`; directories, missing parents and symbolic-link destinations are
  refused. Downloads default to the artifact basename in the current directory.
- Artifact ids and project ids are validated and percent-encoded; a path segment
  cannot escape the `/v1` route.

## Capability truthfulness

Only a capability the engine registry reports as `available` executes. A missing
registry blocks every proposed capability. `unavailable`, `unconfigured`,
`unverified` and `blocked` are displayed with the engine's reason and are never
presented as operational. The CLI contains no provider adapter, model call,
document parser, generator or execution engine to fall back on.

## Timeouts

Every request has a timeout (default 15s, bound to 100–120000 ms) so a hung
deployment cannot block a pipeline indefinitely.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner.
