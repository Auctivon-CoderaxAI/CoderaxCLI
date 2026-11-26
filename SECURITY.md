# Security

Security here does not depend on the repository being private. The repository
is public; every authorization decision that protects Coderax data is made by
the Coderax deployment. The CLI's job is to handle the resulting credentials
without leaking them and to refuse unsafe endpoints, transports and sessions.

## Credentials

Credentials are stored in an operating-system credential store, keyed by a
SHA-256 of the normalized deployment URL:

| Platform | Facility | Secret path |
| --- | --- | --- |
| macOS | Keychain (`/usr/bin/security`) | stdin via `security -i`, never argv |
| Linux | Secret Service (`secret-tool`) | stdin |
| Windows | DPAPI `CurrentUser` | PowerShell stdin; encrypted file under `%APPDATA%`, ACL restricted with `icacls` |

There is **no plaintext-file fallback**. When no OS store is available, login
fails with `CREDENTIAL_STORE_UNAVAILABLE`; automation should use
`CODERAX_TOKEN`, which is read from the environment and never persisted.

On Windows, POSIX mode bits are ignored. The shared secure-store helper removes inherited ACLs and grants the current account explicit access to the config directory, the atomically written config file and the DPAPI ciphertext file. It verifies the resulting ACL with `icacls`; a file that still grants Everyone, Authenticated Users or BUILTIN\Users is repaired when safe or rejected with `CONFIG_PERMISSIONS`/`STORE_PERMISSIONS`. This is the same implementation used by the interactive terminal for private history and attachment files.

Credentials never enter:

- `config.json` — `saveConfig` rejects `token`, `accessToken`, `refreshToken`,
  `idToken`, `password`, `clientSecret` and `apiKey` with
  `CONFIG_SECRET_REJECTED`.
- command arguments — `--token`, `--password`, `--api-key` and similar options
  are rejected with a message explaining that shell history records arguments.
  `coderax login --with-token` reads a deployment token from stdin.
- logs, stdout, stderr, JSON output or error text — access tokens, refresh
  tokens and device codes are passed to the redactor on every request and stream.

A legacy `token` or `accessToken` field in an existing `config.json` is never loaded as a session.
The CLI reports it (`legacyPlaintextToken: true`), migrates it into the OS store
on first authenticated use, and removes the plaintext field. `logout` also
removes it. A one-time migration that cannot rewrite the config fails instead of
silently keeping a copy.

## Credential helper hygiene

- Helpers are spawned without a shell, with a fixed executable path or a PATH
  lookup, and with an explicit timeout.
- Secrets are written to the helper's stdin, not to argv. The macOS provider
  uses `security -i` for the same reason and reads the item back to verify the
  write.
- Helper and browser-launcher processes do not inherit `CODERAX_TOKEN` in
  their environment; only the credential itself is passed on stdin.
- Helper stderr is treated as untrusted, redacted against the secret and
  truncated before it can appear in an error.
- macOS Keychain items are created without `-A`; access remains controlled by
  the OS.

## Transport and endpoint verification

- Remote base URLs must use HTTPS. Plain HTTP is accepted only for `localhost`,
  `127.0.0.1` and `::1`.
- URLs embedding credentials, query strings or fragments are rejected.
- `fetch` uses `redirect: "error"`, so a redirect cannot forward a bearer token
  to another origin.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused while credentials are in use
  (`TLS_VERIFICATION_DISABLED`).
- Before login or storing a token, the deployment must identify itself as
  Coderax through a health response (`service`/`name`/`product`) or its OpenAPI
  `info.title`/`description`. Otherwise login fails with `ENDPOINT_UNVERIFIED`.
- The device `verification_uri` must be on the configured deployment origin and
  use HTTPS (or loopback HTTP).
- A stored credential is bound to the exact normalized deployment URL. A
  `--base-url` that changes the origin is refused rather than sending the token
  elsewhere (`TOKEN_ORIGIN_OVERRIDE`, `CREDENTIAL_ORIGIN_MISMATCH`).
- JWT `iss`, when present, must match the deployment origin
  (`TOKEN_ISSUER_MISMATCH`). `whoami` rejects a changed subject
  (`IDENTITY_MISMATCH`).

## Session lifecycle

- JWT `exp` is enforced locally with no refresh grace for an already-expired
  token. A token within 60 seconds of expiry is refreshed before use.
- Opaque tokens without expiry metadata receive a 12-hour local limit
  (`cli-policy`); a deployment can return `expires_in` to set a shorter or longer
  server-defined lifetime. `CODERAX_TOKEN` is caller-managed and is never
  persisted or refreshed by the CLI.
- Refresh uses `grant_type=refresh_token` with the public `coderax-cli` client
  ID. A rotated refresh token replaces the old one atomically.
- A refresh may narrow scopes. It may not add scopes; the CLI rejects scope
  escalation (`CREDENTIAL_SCOPE_ESCALATION`).
- A `401` triggers exactly one refresh-and-retry. A rejected refresh token
  (`invalid_grant`, `invalid_token`, `expired_token`) deletes the unusable local
  credential and reports `SESSION_EXPIRED`.
- `logout` revokes both token kinds at the deployment's revocation endpoint,
  then deletes the local credential. If revocation fails, the local credential
  is still deleted and the user is warned that the server token may remain valid
  until expiry.

## Scopes

Scopes are enforced client-side only when the token reports them (`scope`, `scp`
or the token response's `scope`). The mapping is documented in
[docs/CONTRACT.md](docs/CONTRACT.md):

| Command | Required scope |
| --- | --- |
| `chat` | `coderax:chat` |
| `work` | `coderax:work` |
| `agents` | `coderax:agents:read` |
| `models` | `coderax:models:read` |
| `call` | `coderax:call` |

`coderax:*` is a wildcard. Tokens that do not report scopes are treated as
legacy/unscoped and rely on server-side enforcement; `auth status` says so. The
CLI's scope check is defense in depth, not a substitute for the deployment
checking the token and scope on every route.

## Output hygiene

- `redact`/`redactValue` accept multiple secrets and choose one marker that is
  disjoint from all of them, so replacing one credential cannot recreate another
  across a marker boundary.
- JSON output stays valid and recursively redacts keys and values, including
  colliding keys and `__proto__`.
- SSE deltas are held back when a suffix could begin any known secret, so a
  credential split across two events is redacted as a whole.
- The unredacted internal OAuth error body is used only to read an error code
  such as `authorization_pending`; it is never printed.
- Unexpected failures print `unexpected failure`, not an exception string that
  might contain request state.

## Provider API keys

The CLI does not ask for, accept, print or store provider API keys (OpenAI,
Anthropic, Google, and so on). Those credentials belong in an authorized cloud
secret store, not in this CLI or its configuration. The only secret this CLI
handles is a Coderax session issued by the deployment.

## Server-side authentication is authoritative

The deployment, not the CLI, verifies the access token's signature, issuer,
audience and expiry, resolves its subject, and authorizes the owner on every
route. A JSON Web Token is decoded locally only to apply defence-in-depth checks
(expiry, issuer origin, optional `CODERAX_AUDIENCE`, optional `CODERAX_ISSUER`
pin, subject continuity and scope); decoding is never treated as authentication.
An unsigned JWT (`alg: none`) is rejected, but a valid-looking signature is not
verified locally because the CLI does not possess the deployment's keys.

The CLI stores a session only after an authenticated `GET /api/user` reports the
instance-owner role (`ADMIN`). It cannot grant an account, a role, a scope or a
token. `whoami`, login and `doctor` repeat the owner check; all data operations
must still be authorized by the backend.

## Write safety, approvals and untrusted content

- Chat `POST /api/work/chat` is never retried: a retry starts a second generation
  and may double-charge the owner. An interrupted turn exits `7` with its
  conversation id. Durable runs reconnect only with snapshots or event ids and
  de-duplicate replay.
- Auth expiry never auto-restarts a Work submission. The existing task/run id and
  idempotency key remain authoritative; reauthenticate, then resume monitoring
  with `coderax run <id>` or inspect `coderax tasks`.
- Approval defaults to `ask`. A non-interactive session fails closed with
  `waiting_approval`; `allow` and `deny` are explicit operator choices.
- `--notify-command` is operator-supplied shell code. Server text is never
  interpolated into it.
- Response text, task titles, repository names and errors are untrusted. They are
  redacted and stripped of terminal control sequences before human output, never
  evaluated, and never treated as instructions.

## Residual risks

- Any process running as the same OS user can ask the user's credential store
  for the item; OS keychain security is user-account security, not
  process-isolation security.
- A locked or unavailable keyring makes login fail rather than falling back to a
  file. The error is explicit and `auth status` reports store availability.
- Login uses trust-on-first-use for the deployment URL: the user chooses the URL,
  and TLS plus the Coderax identity marker bind the session to it. An attacker
  who controls the URL before the first login is outside this CLI's threat model.
- `CODERAX_TOKEN` is only as safe as the process environment and CI secret
  configuration that supplies it.
- libsecret's `secret-tool` accepts at most 8 KiB for one stored password. A very
  large access/refresh token pair can exceed that; login then fails explicitly
  rather than truncating or falling back to a file.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not open
a public issue containing a token, a device code or a deployment URL that is not
already public.
