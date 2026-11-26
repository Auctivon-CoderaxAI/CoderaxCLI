# Capabilities

A capability command is a typed, owner-authorized request for the engine to do
work in the cloud. The CLI validates the request, submits it, reports progress
and hands back the artifacts. It never performs the work itself and never claims
a capability the engine is not currently serving.

## Where availability comes from

`GET /v1/handshake` publishes, for each capability the engine knows:

```json
{
  "capabilities": {
    "work":        { "state": "available",     "detail": "durable Work tasks" },
    "artifacts":   { "state": "available",     "detail": "task-scoped artifact storage" },
    "multimodal":  { "state": "unsupported",   "detail": "contract 1.1.0 publishes no media operation" },
    "scheduling":  { "state": "available",     "detail": "durable schedules" }
  },
  "operations": [
    { "operationId": "submitWork", "method": "POST", "path": "/v1/work", "tags": ["work"], "auth": "owner", "stream": false }
  ]
}
```

Every family in [`src/capability-catalog.js`](../src/capability-catalog.js)
declares the capability keys and operations it needs. The resolver applies a
fixed precedence:

1. an incompatible contract → `unverified`;
2. no published operation for a dedicated backend → `not_implemented`;
3. a required operation missing from the handshake or unknown to the SDK →
   `unverified`;
4. the family's own capability `unsupported` → `unavailable`;
5. the family's own capability `unconfigured` → `unconfigured`;
6. a prerequisite `unsupported` or `unconfigured` → `blocked`, naming the key;
7. any other non-`available` state → `unverified`;
8. otherwise → `available`.

Only `available` executes. The refusal is `CAPABILITY_NOT_AVAILABLE` (exit `6`)
and includes the exact prerequisite, for example:

```
create-document is blocked: requires multimodal: contract 1.1.0 publishes no media operation.
The CLI does not fall back to local execution or simulate the result.
```

## Families

`W` = executed as a Work objective (`POST /v1/work`); `O` = requires dedicated
engine operations discovered from the handshake.

| Command | Kind | Requires | Notes |
| --- | --- | --- | --- |
| `upload <file> --task <id>` | artifact | work, artifacts | stores bytes on an existing owner task |
| `create-document <prompt>` | W | work, artifacts | `--format md\|txt\|docx\|pdf`, `--name` |
| `analyze-document <file>` | W + attachment | work, artifacts, multimodal | `--question` |
| `create-pdf <prompt>` | W | work, artifacts | `--name` |
| `analyze-pdf <file>` | W + attachment | work, artifacts, multimodal | `--question` |
| `create-spreadsheet <prompt>` | W | work, artifacts | `--format xlsx\|csv` |
| `analyze-spreadsheet <file>` | W + attachment | work, artifacts, multimodal | `--question` |
| `create-presentation <prompt>` | W | work, artifacts | `--format pptx\|pdf`, `--file` optional |
| `analyze-data <prompt>` | W | work, artifacts | `--file`, `--question` |
| `visualize-data <prompt>` | W | work, artifacts | `--file`, `--chart` |
| `understand-image <file>` | W + attachment | work, artifacts, multimodal | `--question` |
| `generate-image <prompt>` | W | work, artifacts | `--size`, `--count` |
| `edit-image <file>` | W + attachment | work, artifacts, multimodal | `--instruction` |
| `transcribe <file>` | W + attachment | work, artifacts, multimodal | `--language`, `--format` |
| `speak <text>` | W | work, artifacts | `--voice`, `--format` |
| `understand-video <file>` | W + attachment | work, artifacts, multimodal | `--question` |
| `create-software <prompt>` | W | work, artifacts | `--name` |
| `create-game <prompt>` | O | work + `/v1/games` operations | Native Game Studio |
| `gaming-agent <objective>` | O | work + `/v1/games` operations | Native Gaming Agent |
| `orchestrate <prompt>` | W | work, multiAgent | `--agent` |

Dedicated families are not assumed absent because a branch is unmerged. The
resolver looks at the live handshake for an operation tagged `games` /
`game-studio` / `gaming-agent` or under `/v1/games`. Until a deployment publishes
one, the status is `not_implemented`; the moment it does, the status becomes
`available` with no CLI change.

## Options are validated locally

Unknown options are rejected before any request. Values are constrained by the
catalogue (`--format`, `--size`, `--count`, `--chart`) and reserved transport
options cannot be redefined by a capability. `--force` without `--out` on a
capability request is a usage error: the operator must name the file they are
authorizing to replace.

## File validation

Before a byte leaves the machine:

- the path must be a regular file, not a symlink or directory;
- it must be non-empty and within the family's limit (8 MiB hard bound);
- the contents must be a supported type identified from magic bytes;
- the extension and the magic bytes must agree;
- the MIME type must be in the family's accepted set;
- the exact bytes are hashed with SHA-256.

The engine must echo the same digest and byte count. A mismatch cancels the task
and exits `1`.

## Waiting, progress and cancellation

- Default: wait for the terminal state.
- `--no-wait`: print the accepted task id and return; the task continues.
- `--wait-timeout <ms>`: local deadline (1 s–1 h, default 10 min). Reaching it
  exits `4` with the authoritative state and does not cancel the task.
- `--stream`: write each execution event to stderr as JSON; stdout stays one
  JSON document with `--json`.
- `awaiting_approval`: the CLI prints the request id and the exact
  `coderax permissions approve` command, then keeps waiting.
- Ctrl-C stops local waiting and reports `130`; the durable task continues.

## Structured output

`--json` returns one document. Capability execution includes
`{accepted, capability, attachment, task, artifacts, downloaded, events, waited}`.
Failures use the CLI error contract and still exit with the documented code. No
human progress is written to stdout in JSON mode.

## What is never done

- No provider adapter, model call, OCR, transcription, rendering or code
  execution in the CLI.
- No local artifact generation and no local artifact catalog.
- No capability claim from documentation, a branch name or a test count; only
  the live handshake.
- No silent fallback from `unavailable` to another agent or another route.
