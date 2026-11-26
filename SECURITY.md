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

Contract 1.1.0 transfers artifact bytes as base64 inside JSON, scoped to one
owner task. The CLI's rules are:

- Uploads are limited to regular files, are non-empty, and are checked against
  both the extension and the file's magic bytes before any byte leaves the
  machine. Symbolic links and directories are refused. Accepted MIME types and
  per-family limits come from the capability catalogue; the hard bound is 8 MiB,
  below the contract's 12M-character base64 limit.
- The exact bytes are hashed with SHA-256 locally. The engine returns
  `sha256:<64 hex>` and a byte count for the stored artifact; both must equal the
  local values. Otherwise the task is cancelled and the command fails with
  `ARTIFACT_INTEGRITY_FAILED`.
- Artifact paths are reduced to a safe basename, must be relative, and may not
  contain `..` or a drive letter. A server-supplied name is never used as a
  directory.
- Downloads require a published digest. The base64 body is decoded, bounded,
  hashed, and compared with the artifact metadata (including its byte count)
  before the file is created. A mismatch writes nothing.
- A destination is never overwritten implicitly. Existing files require
  `--force`; directories, missing parents and symbolic-link destinations are
  refused. Downloads default to the artifact basename in the current directory.
- A `--force` without an explicit `--out` is refused for capability execution,
  so the operator names the file they are authorizing to replace.
- Artifact and task ids are validated and percent-encoded by the SDK; a path
  segment cannot escape the `/v1` route.

## Capability truthfulness

Only a family the live handshake reports as `available`, with every prerequisite
and required operation available, executes. `unavailable`, `unconfigured`,
`unverified`, `blocked` and `not_implemented` are displayed with the engine's
reason and are never presented as operational. The CLI contains no provider
adapter, model call, document parser, generator or execution engine to fall back
on, and it does not infer a capability from documentation, a branch name or a
test count.

## Supply chain

- The WorkflowEngine client and contract schemas are vendored from the engine's
  published `dist-artifacts` and verified against the published `SHA256SUMS`;
  see `vendor/PROVENANCE.md` and `vendor/SHA256SUMS`.
- `zod` is the only npm dependency; `package-lock.json` pins the tree.
- No install script, postinstall hook, telemetry or remote configuration is
  added by the CLI.

## Timeouts

Every request has a timeout (default 15s, bound to 100–120000 ms) so a hung
deployment cannot block a pipeline indefinitely.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner.
