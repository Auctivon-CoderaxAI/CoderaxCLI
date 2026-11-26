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

## Terminal output

All untrusted text (model output, tool names, resources, file names) passes
through `src/terminal/sanitize.js` before measurement or rendering. CSI, OSC
(including OSC 52 clipboard writes and window titles), DCS, APC, PM, SOS, C0/C1
controls, DEL, bidi overrides and lone surrogates are removed. The sanitiser is
stateful, so an escape sequence split across two SSE deltas is still removed.
Model text never supplies ANSI bytes: markdown produces style *names* and the
theme decides the bytes. Bracketed paste is bounded and control characters are
stripped.

## Permission approvals

An approval is shown only when the request arrives on a verified server channel
and carries a server-issued request id, execution identity, allowed action and
concrete resource. The CLI rejects model-generated or malformed requests and
never prompts for them. Approval echoes the exact request id, execution id,
action and SHA-256 resource hash. A session grant is scoped to that exact
action, resource and execution and is dropped when the execution ends; there is
no blanket "allow all". If delivery of an approval fails, the CLI treats it as a
denial and cancels the response. The legacy transport has no verified approval
channel, so permission requests there fail closed.

## Local files

`@path` references are not read automatically. Each file is resolved without
following symlinks, checked against a sensitive-path denylist (`.env`, keys,
credential stores, `.git`, `.coderax`, and similar), confined to the working
directory by default, size-limited, checked for binary content, hashed, and
shown to the operator for an explicit per-send approval. Declining sends
nothing. Symlink following and out-of-directory access require explicit
environment opt-ins and still require approval. File content is never written
to history or logs.

## Prompt history

`history.json` lives beside the config and contains prompts only: never
responses, tool output or file contents. Prompts matching secret patterns or
containing local-file references are skipped. Retention and maximum entry count
are configurable; `history clear` deletes the file and `history off` deletes it
and disables conversation metadata persistence. `--no-history` disables both for
one run.

## Platform file permissions

`src/secure-store.js` verifies rather than assumes. POSIX files must be mode
`0600` and owned by the current uid, directories `0700`; macOS ACLs are checked
with `ls -le`; Windows ACLs are checked with `icacls` and any entry for
Everyone, Users or Authenticated Users is rejected. Verification failure is an
error, and the config writer performs the same check after its atomic rename. A
missing or unverifiable ACL tool fails closed.

## Timeouts

Every request has a timeout (default 15s, bound to 100–120000 ms) so a hung
deployment cannot block a pipeline indefinitely.

## Non-goals

Storing refresh tokens, OIDC device flows, or acting as a credential broker.
Deployment-bound OIDC machine identities are issued and validated by the Coderax
deployment; the CLI only carries the resulting bearer token.

## Reporting

Report suspected vulnerabilities privately to the repository owner.
