# CLI consolidation record

This branch reconciles the CLI against the **designated** WorkflowEngine target
(PR #7, `9b4cb5c`) and now absorbs the surviving functionality of
`feat/secure-owner-auth`, `release/installers-completion` and
`feat/terminal-client-completion` **without** importing any of their duplicate
SDKs or command surfaces.

The branches were consolidated by porting their authoritative modules onto
`src/engine.js` and the canonical `@coderax/sdk` 1.1.0. They were not merged
wholesale: every one of them rewrites `src/cli.js`, and three add a second
transport or a second SDK.

## Engine target

| Surface | Authority | State |
| --- | --- | --- |
| API + SDK consolidation target | WorkflowEngine PR #7, `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f` | verified; hosted `verify` succeeded at that HEAD |
| Published SDK | `packages/sdk/artifacts/coderax-sdk-1.1.0.tgz` | `sha256:520a0cf8…73db`, 32,581 bytes |
| Contract served | `1.1.0`, 30 operations | verified against the real server |
| Competing 1.1.0 | `contract/authoritative-v1.1`, `ea66028` | different SDK, different artifact routes; **not** consumed |

The two 1.1.0 artifacts are not interchangeable: the authoritative branch exports
`negotiate()`/`parseSse()`/`SDK_COVERAGE` and `/v1/artifacts/{id}[/content]`; PR
#7 exports `handshake({contract})`/`compatibility()`/`SDK_OPERATION_COVERAGE` and
task-scoped `/v1/work/{taskId}/artifacts/{artifactId}`. This client negotiates
the served contract at runtime and gates every command on the operations the
engine actually publishes.

## What was consolidated

### Owner authentication — `feat/secure-owner-auth`

| Kept | Rewired | Not imported |
| --- | --- | --- |
| `src/secure-store.js` (POSIX mode/owner, macOS `ls -le`, Windows `icacls` reset + verify) | `login`/`logout`/`status` now call `src/auth.js` and `src/engine.js` | `packages/workflow-sdk/**` |
| `src/credentials.js` (Keychain, libsecret, DPAPI; secrets over stdin; helper env scrubbed) | Owner verification is the canonical handshake plus `GET /v1/agents` | `src/workflow-commands.js` (second command surface) |
| `src/auth.js` (new): token verification before storage, read-back verification, legacy-token migration, source reporting | `/api/user` is used only for a display label; 404 is not a failure | The branch's 1,595-line OAuth/device/refresh machinery |

Consequences:

- `config set --token` is refused; the config file holds only the URL, account
  label and timeout, written atomically with mode `0600`.
- `login --token-file <path>` refuses symlinks and group/other-readable files;
  `login --with-token` reads stdin. `--token` remains a one-shot automation
  override and is never persisted.
- A legacy plaintext token is still honoured for one migration window with a
  warning; a successful `login` removes it only after the store read-back
  matches.
- Device-code login is not implemented because contract 1.1.0 publishes no
  device authorization operation. The branch's device flow would have required
  inventing endpoints.

### Installers and release — `release/installers-completion`

Ported: `scripts/install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1`,
`build-release.mjs`, `verify-release.mjs`, `repro-check.mjs`,
`install-check.mjs`, `scripts/lib/archive.mjs`, `.github/workflows/release.yml`,
`.gitattributes`, `src/completion.js` (PowerShell plus a generated-file marker),
and `docs/INSTALL|DISTRIBUTION|RELEASE|ROLLBACK|UPGRADE|COMPATIBILITY.md`.

Adaptations required by this branch:

- The standalone archive now bundles the pinned runtime dependencies
  (`@coderax/sdk`, its contracts, `zod`) because this client has a runtime SDK.
  `verify-release.mjs` allows `node_modules/` **only** in the standalone tree;
  the npm tarball still forbids it.
- The release manifest's engine range comes from `src/version.js`
  (`>=1.0.0 <2.0.0`), not the retired `src/version.js`.
- Release verification still forbids subprocesses everywhere except the two
  credential-store helpers, and asserts the credential helper scrubs the token
  from child environments.
- `package.json` gains `files`, `exports`, repository metadata, and
  `build`/`verify`/`repro`/`install-test` scripts. `private` stays `true`.

### Interactive terminal — `feat/terminal-client-completion`

Ported: `src/ui/ansi.js`, `markdown.js`, `prompt.js`, `tables.js`,
`presenter.js`, and a new `src/interactive.js` REPL.

The REPL supports streaming Chat, durable Work with the Work presenter and
inline permission decisions, `/task`, `/tasks`, `/cancel`, `/artifacts`,
`/permissions`, `/doctor`, `/models`, `/agents`, `/caps`, `/mode`, `/help` and
`/quit`. It rejects non-TTY invocation and maps Ctrl+D to a clean exit.

**Not** imported from the branch: `src/engine/client.js`, `contract.js`,
`stream.js`, `submit.js`, `src/http.js`, its `auth.js`/`credentials.js`, its
`src/commands/*` tree, and its full 842-line slash-command application. Those
were a second transport and a second command layer. Session history is kept in
memory for the lifetime of the REPL; it is not persisted, so no prompt history
is written to disk.

## Single authority per component

| Component | Authoritative implementation | Notes |
| --- | --- | --- |
| SDK integration | `src/engine.js` + vendored `@coderax/sdk` 1.1.0 | one client; no second transport |
| Command dispatch | `src/cli.js` | one parser and one exit-code map |
| Capability resolver | `src/capability-registry.js` | handshake flags + operation set + SDK coverage |
| Capability catalogue | `src/capability-catalog.js` | UX metadata only; no backend claims |
| Streaming parser | `@coderax/sdk` (`events()`, `chatStream()`) | the CLI does not parse SSE itself |
| Artifact transfer | `src/file-transfer.js` | validate, hash, base64, verify, non-overwrite |
| Owner credentials | `src/auth.js` + `src/credentials.js` + `src/secure-store.js` | OS store only; no plaintext fallback |
| Interactive terminal | `src/interactive.js` + `src/ui/*` | one TUI on the one engine adapter |
| Release pipeline | `scripts/*` + `.github/workflows/release.yml` | one installer, one artifact set |
| Task continuity | `@coderax/sdk` event cursor + `followTask()` | dedupe by `seq`/`eventId`, resume with `after` |

## Duplicate implementations retired

| Branch | Duplicate | Resolution |
| --- | --- | --- |
| `feat/owner-cloud-client-contract` (PR #5) | `packages/workflow-sdk/**` | not imported; canonical SDK used |
| `feat/secure-owner-auth` | `packages/workflow-sdk/**`, `src/workflow-commands.js` | not imported; secure store/credential modules ported |
| `feat/task-synchronization` | `packages/workflow-sdk/**`, `src/task-store.js` | still on its branch; map its cursor onto event `seq` before merging |
| `feat/terminal-client-completion` | `src/engine/client.js`, `src/engine/stream.js`, `src/http.js` | not imported; UI ported onto `src/engine.js` |
| `feat/engine-thin-client-v1` | `src/engine.js`, `src/sse.js` | superseded by this branch's adapter and the SDK stream |
| `feat/workflow-command-surface` | `packages/workflow-sdk/**`, `src/engine-client.js`, `src/sse.js` | keep release machinery; delete the duplicate client |
| `integration/pr6-terminal` | `src/sdk.js`, `src/sdk-legacy.js`, `src/workflow-commands.js` | not merged; its terminal modules are superseded by this port |

## Remaining merge order

1. PR #4 (`ci/fix-work-sse-fixtures`) — test-only fixture correction.
2. PR #5 (`feat/owner-cloud-client-contract`) minus `packages/workflow-sdk`.
3. ~~`feat/secure-owner-auth`~~ — **consolidated here**.
4. PR #6 / ~~`release/installers-completion`~~ — **release pipeline consolidated here**.
5. ~~`feat/terminal-client-completion`~~ — **UI and REPL consolidated here**.
6. `feat/task-synchronization` — cursor persistence over the canonical events.
7. This branch — capability, artifact, schedule and permission surface.

## Genuine integration evidence

Against the real PR #7 engine (`node dist/src/main.js`, loopback port):

- handshake: contract `1.1.0`, compatible, 30 operations, **zero SDK coverage gaps**;
- 10 available families; 8 `unverified`; 2 `not_implemented`;
- `create-document --no-wait` returned an accepted task;
- `upload` stored a 64-byte PDF and the engine digest matched the local SHA-256;
- `artifacts list --task` returned that record;
- `schedules create --interval-ms 60000` and `schedules pause` succeeded;
- the task failed with `provider_error` only because the integration instance
  pointed at a deliberately unreachable inference endpoint.

Against the real-HTTP contract harness:

- owner login verified the handshake and `GET /v1/agents` before storing a
  credential, wrote **no** token to the config file, resolved it from the
  credential store for `status`, and removed it on `logout`;
- a PTY session displayed the banner, `/help` and `/version`, ran a durable
  `/work` task to `completed` with its artifact, streamed a `/chat` reply, and
  exited 0 on `/quit`.

## Verification at this HEAD

- Local suite: **122 passed, 0 failed** (Node 24.22.1, Linux), including the
  rewritten secure-login test.
- `npm run check`: syntax and vendor checksum pass.
- `npm run build`, `npm run verify`, `npm run repro`: pass; 3 artifacts,
  649 inventoried files, byte-identical rebuild including `dist/`.
- Hosted matrix: exact-HEAD run
  [`45903747815`](https://github.com/Auctivon-CoderaxAI/CoderaxCLI/actions/runs/45903747815)
  passed `ubuntu-latest`, `macos-latest` and `windows-latest` at implementation
  commit `d65a0a2`. The follow-up that records this result is documentation only.

## Remaining blockers

- **No pull request exists for this branch.** There is no authorised GitHub
  integration or token in this chat, and `cloud_git` supports fetch/pull/push
  only. The owner must open the PR from the compare link or connect GitHub.
- **No genuine independent approval** has been recorded.
- WorkflowEngine `main` still serves `1.0.0`; the target surface exists only on
  PR #7 and the competing authoritative branch.
- PR #7 stores artifacts and schedules in process memory. `feat/durable-artifacts`
  is not merged, so this client makes no cross-device or version-history claim.
- Web↔CLI continuity is still unverified: there is no deployed Coderax gateway
  in this environment to prove a conversation or task is visible in both.
- A headless Linux runner without `secret-tool` cannot complete an end-to-end
  owner login; the suite injects an in-memory store and the real store is
  covered by unit tests. `CODERAX_TOKEN` remains the CI path.
- Device-code login, refresh tokens and token revocation are not implemented
  because contract 1.1.0 publishes no such operations. They are not simulated.
- Media, creative and games operations are absent from PR #7; those families
  report `unverified` or `not_implemented`.
- `feat/task-synchronization` and PR #5's product work remain to be merged by
  their owners in the order above.
