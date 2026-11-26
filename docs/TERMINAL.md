# Interactive terminal

The interactive client is intentionally thin. It renders events from the
transport, collects prompts and approvals, and never routes models, executes
workflows or stores response content.

## Starting a session

```sh
coderax chat                                   # chooses interactive when stdin is a TTY
coderax chat "one-shot prompt"                 # non-interactive streaming
coderax work --interactive --model gpt-4.1 --agent reviewer
coderax chat --accessible                      # line-oriented mode
coderax chat --resume <id>                     # start from a stored conversation
coderax chat --no-history                      # no reads or writes this run
```

`--base-url` can point at a local gateway. `CODERAX_SDK` selects the transport:
`legacy` (default), `auto`, or `canonical`. See [CONTRACT.md](CONTRACT.md).

## Input

`src/terminal/keys.js` parses bytes, including split escape sequences, bracketed
paste, CSI/SS3 keys and Alt-modified keys. `src/terminal/editor.js` edits by
grapheme cluster, so CJK characters, combining marks and emoji are deleted as
one cell; every width calculation goes through `src/terminal/text.js`.
`Ctrl+J` or `Alt+Enter` inserts a newline, `Enter` sends. `Up`/`Down` move
between input lines when the prompt has more than one, otherwise they browse
history. Tab completes commands and values.

`--accessible` (or `TERM=dumb`) replaces the cursor-addressed prompt with a
readline prompt and numbered menus. Output is plain lines, with no cursor
movement.

## Rendering

`src/terminal/renderer.js` owns the prompt region, spinner, resize handling and
the bounded block of recent output used to reflow on resize. It keeps at most
200 rows / 64 KiB of that block; older rows are the terminal's own scrollback.
`src/terminal/markdown.js` streams completed markdown lines immediately, renders
unfinished lines through a bounded preview tail, and highlights code blocks.
Tool activity is capped at 200 events and the markdown buffer at 2 MiB, at which
point the client prints an explicit truncation notice instead of retaining more.

All untrusted text goes through `src/terminal/sanitize.js`: ANSI CSI, OSC (OSC 52
clipboard writes included), DCS, APC, PM, SOS, C0/C1 controls, DEL, bidi
overrides and lone surrogates are stripped before measuring or drawing. The
sanitizer is stateful across streaming deltas. A terminal resize triggers a
reflow of the retained block using the new width; no unbounded copy is kept.

## Permissions

Permission prompts appear only for server-issued requests on a channel that
declares `verifiedPermissions`. The UI shows the execution identity, action and
canonical resource, and `PermissionBroker` binds the approval to
`requestId + executionId + action + resource hash`. Session grants never widen.
Malformed requests are denied without asking. When the transport has no verified
channel (the legacy SSE implementation), the request is surfaced as refused and
the response is cancelled. Approval delivery failure is treated as a denial.

## Attachments

`@path` in a prompt is a reference, not an instruction to read a file. Before a
send, `src/terminal/attachments.js` resolves it without following symlinks,
refuses sensitive names, refuses paths outside the working directory unless
explicitly enabled, refuses directories, binaries and files above the size
limit, then computes a SHA-256. The operator sees path, size and digest and must
approve that send. Nothing is read into the prompt or history.

## History

`history.json` and `conversations.json` sit beside the config. History stores
prompts only; conversation metadata stores IDs, timestamps, counts and an
optional short non-sensitive title. Sensitive prompts and prompts containing
file references are skipped. Bounds: configured prompt retention/count (default
7 days / 200 entries) and 50 conversations. `history clear` deletes history,
`history off` also deletes and stops conversation metadata, and `--no-history`
disables both. Files are verified after writes by `src/secure-store.js`: POSIX
mode/owner, macOS ACLs, Windows `icacls`; a failure is reported, not ignored.

## Tests

- `test/terminal-*.test.js` — sanitizer, width/graphemes, keys, editor,
  completion, markdown/highlighting, renderer bounds and resize, memory caps,
  permissions, attachments, history, CLI integration, session orchestration.
- `test/pty.test.js` — real pseudo-terminal via `script` on Linux and macOS:
  narrow PTY, Unicode/wide input and editing, streamed markdown, Ctrl+C
  interruption, clean `/quit` exit, no raw escapes or OSC 52 in output.
- `test/windows-terminal.test.js` — Windows ACL creation/verification and CLI
  guard behaviour; skipped on other platforms.
- `.github/workflows/ci.yml` — `test` matrix on Ubuntu, Windows and macOS, and a
  dedicated real-PTY job on Ubuntu and macOS.

There is no local inference, WSL, Ollama or development workload on the
operator's machine. The terminal is an access and control client; tests use a
local stub gateway, and live connectivity is not claimed until the deployed
gateway and WorkflowEngine are independently verified.
