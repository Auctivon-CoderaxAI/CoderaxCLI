# Capability and artifact contract

Version: CLI `0.2.0`, consuming WorkflowEngine contract `1.0.0` and the shared
`@coderax/sdk` `1.0.0` semantics.

## Source of truth

`Auctivon-CoderaxAI/Coderax-WorkflowEngine` owns the capability registry, the
execution contract, upload handling, artifact generation and artifact storage.
This CLI owns none of that. It discovers what the engine publishes, displays the
engine's availability verdict, submits a request when the engine says the
capability is available, and renders or downloads the result.

`packages/contracts/src/routes.ts` in WorkflowEngine is the authoritative HTTP
surface for the operations that exist today. The capability routes below are the
client-side contract this CLI implements; the engine must publish them before a
capability can become operational. The CLI never substitutes a local adapter, a
model call, a document parser or a generator for a missing engine route.

### Inspected baseline (26 November 2026)

| Surface | State |
| --- | --- |
| HTTP contract version | `1.0.0` — `packages/contracts/src/primitives.ts` |
| Execution event schema | `1` — `packages/contracts/src/events.ts` |
| Shared SDK | `@coderax/sdk@1.0.0` — `packages/sdk/package.json` |
| Published operations | health, readiness, agents, models, chat, work, task, cancel, resume, retry, events, conversations, memory, permissions, notifications |
| Multimodal / upload / artifact operations | **not published on `main`** |
| Active integration PRs | #2 intelligence core, #3 native reasoning, #4 zero-cost router; none publishes these routes |
| CLI migration onto the engine API | **not done** — stated by the engine README |

Therefore, against an engine at that baseline, `coderax capabilities` reports
every capability as `blocked` with `reason: capability_registry_missing`. That is
the truthful result, not a failure of the CLI. No capability is advertised as
operational until the engine publishes it as `available`.

## Statuses

Every capability and the artifact surface carry exactly one status. Only
`available` executes.

| Status | Meaning | CLI behaviour |
| --- | --- | --- |
| `available` | The engine verified the capability for this deployment. | May upload inputs and execute. |
| `unavailable` | Supported by the engine but not reachable or temporarily disabled. | Refuses with `CAPABILITY_NOT_AVAILABLE` (exit 6). |
| `unconfigured` | The owner must configure a prerequisite. | Refuses and shows the engine's reason. |
| `unverified` | No verification evidence exists. | Refuses; never presented as operational. |
| `blocked` | A known prerequisite prevents safe operation. | Refuses with the blocker detail. |

An unknown status from a newer engine is downgraded to `unverified`, never to
`available`. A capability omitted from the registry is `blocked`
(`reason: not_published`). An `available` capability whose execution route is
missing still fails at the engine and is reported as such; the CLI does not
simulate it.

## Registry

`GET /v1/capabilities` (owner bearer auth)

```json
{
  "contractVersion": "1.0.0",
  "registryVersion": "2026-11-26T12:00:00.000Z",
  "capabilities": [
    {
      "id": "pdf.analyze",
      "command": "analyze-pdf",
      "title": "PDF analysis",
      "summary": "Analyze a PDF in the cloud.",
      "status": "available",
      "reason": "ready",
      "detail": "",
      "inputs": [
        {
          "name": "file",
          "type": "file",
          "required": true,
          "description": "PDF to analyze",
          "mimeTypes": ["application/pdf"],
          "maxBytes": 52428800
        },
        {
          "name": "question",
          "type": "text",
          "required": false,
          "description": "Question to answer"
        }
      ]
    }
  ],
  "artifacts": {
    "status": "available",
    "reason": "ready",
    "detail": "",
    "digestRequired": true
  }
}
```

Input `type` is one of `file`, `text`, `string`, `number`, `boolean`, `enum`.
`enum` requires `values`; `number` may declare `min`, `max` and `integer`.
`file` may declare `mimeTypes` and `maxBytes`; the CLI caps the effective upload
limit at 50 MiB. Input names are lower-case kebab-case and may not reuse a
transport option (`--project`, `--out`, `--stream`, `--json`, and so on).

The CLI's static catalog (`src/capability-catalog.js`) supplies stable command
aliases and offline help. It is not an availability claim. The registry decides
which aliases exist, which options they take and whether they run. A
registry-only capability is listed and executable through:

```sh
coderax capabilities --json
coderax capability run <id|command> [options]
```

The contract major version must be `1.x`. A different major version fails with
`CAPABILITY_CONTRACT_INCOMPATIBLE` rather than being parsed optimistically.

## Execution

`POST /v1/capabilities/{capabilityId}/execute` (owner bearer auth)

```json
{
  "capabilityId": "pdf.analyze",
  "inputs": {
    "file": {
      "uploadId": "upl_...",
      "name": "report.pdf",
      "bytes": 184320,
      "sha256": "...",
      "mimeType": "application/pdf"
    },
    "question": "What changed?"
  },
  "projectId": "proj_...",
  "conversationId": "conv_...",
  "wait": true
}
```

The response is WorkflowEngine's `TaskAccepted` shape:

```json
{
  "taskId": "task_...",
  "conversationId": "conv_...",
  "state": "queued",
  "generation": 1,
  "eventsPath": "/v1/work/task_.../events"
}
```

The task is durable. `--no-wait` returns immediately; closing the terminal never
cancels authorized cloud work. While waiting, the CLI tails
`GET /v1/work/{taskId}/events` and falls back to
`GET /v1/work/{taskId}` if the stream is absent or interrupted. Terminal events
are followed by a task snapshot, which is authoritative for the result.

Task states: `queued`, `running`, `awaiting_approval`, `completed`, `failed`,
`cancelled`, `interrupted`. `failed`, `cancelled` and `interrupted` are reported
as failures with the engine's code and detail; they are never rendered as an
empty success.

## Uploads

`POST /v1/files` (owner bearer auth, `multipart/form-data`)

Fields: `file` (required), `sha256`, `bytes`, `mimeType`, optional `projectId`
and `conversationId`. The request also carries `x-content-sha256`. The engine
must echo `uploadId`, `name`, `bytes`, `sha256` and `mimeType`; a byte-count or
digest mismatch aborts the command with `UPLOAD_INTEGRITY_FAILED` before any
execution request is sent.

Local validation happens before the request:

- regular file only; symbolic links and directories are refused;
- non-empty and within the registry limit (hard cap 50 MiB);
- extension and magic bytes must agree (PDF, PNG/JPEG/GIF/WebP, MP3/M4A/WAV/OGG/FLAC/WebM,
  ZIP-based office formats, OLE office formats, RTF and UTF-8 text);
- type must be in the registry's `mimeTypes`;
- SHA-256 is computed from the exact bytes sent.

## Artifacts

Artifacts are owner-scoped engine records, not CLI-local files. Coderax Web and
CoderaxCLI use the same catalog, so an artifact generated by either client is
visible to the other under the same owner, project and conversation.

| Operation | Route |
| --- | --- |
| list | `GET /v1/artifacts?projectId=&conversationId=&taskId=&limit=` |
| inspect | `GET /v1/artifacts/{artifactId}` |
| download | `GET /v1/artifacts/{artifactId}/content` |
| associate project | `POST /v1/artifacts/{artifactId}/project` with `{ "projectId": "..." }` |

Artifact metadata must include `artifactId`, `name`, `bytes` and a SHA-256
`digest`. A download is written to a temporary file (or an exclusively created
destination), hashed while streaming, checked against the published digest and
byte count, and only then moved into place. A mismatch deletes the downloaded
data and exits with `ARTIFACT_INTEGRITY_FAILED`.

The CLI never overwrites an existing destination unless `--force` is supplied.
It refuses directories, missing parents and symbolic-link destinations. `--out`
defaults to the artifact's basename in the current directory; because existing
files are never replaced, an explicit `--out` or `--force` is required to
replace one.

## Authentication, memory, conversations, permissions and projects

The CLI adds no identity of its own. Every request carries the owner's bearer
token from the existing Coderax configuration (`CODERAX_TOKEN` or the `0600`
config file). The engine decides ownership, project and conversation access,
permission requests and memory scope. `--project` and `--conversation` are
forwarded as references, never as a substitute for authorization.

A `409 permission_required` is surfaced with the engine's stable code and
detail. The CLI does not auto-approve, retry around a denial, or substitute a
different agent.

## CLI command map

| Command | Capability id |
| --- | --- |
| `upload` | `file.upload` |
| `analyze-document` | `document.analyze` |
| `analyze-pdf` | `pdf.analyze` |
| `analyze-spreadsheet` | `spreadsheet.analyze` |
| `create-presentation` | `presentation.create` |
| `understand-image` | `image.understand` |
| `generate-image` | `image.generate` |
| `transcribe` | `audio.transcribe` |
| `speak` | `audio.speech` |
| `create-software` | `software.create` |
| `create-game` | `game.create` |
| `artifacts list/inspect/download/associate` | registry `artifacts` surface |

Aliases: `caps` = `capabilities`, `stt` = `transcribe`, `tts` = `speak`.

## Output and progress

- Human output: results on stdout, progress on stderr.
- `--json`: one structured object on stdout; errors remain on stderr.
- `--stream --json`: NDJSON events first, then one `{"type":"result",...}` line.
- `--no-wait`: one `TaskAccepted`-shaped object; no polling.
- `--wait-timeout <ms>`: local wait limit (1000–3600000, default 600000). On
  timeout the task keeps running in the cloud and the CLI reports
  `WAIT_TIMEOUT` with the task id.

Exit codes follow the existing contract; capability-specific additions:

| Code | Condition |
| --- | --- |
| `2` | local input validation (`CAPABILITY_INPUT_INVALID`, `UPLOAD_*`, destination errors) |
| `6` | capability not available or registry missing |
| `130` | local wait cancelled (the remote task continues) |
| `1` | engine task failure, integrity failure, contract incompatibility |

## What this CLI deliberately does not do

- No provider SDK, OCR, document parser, image/audio model, code generator or
  game runtime.
- No local execution, sandbox or artifact synthesis.
- No retries that could duplicate a billable or side-effecting run.
- No authorization decision; no permission auto-approval.
- No second copy of the engine data model or a hand-written capability payload
  beyond the documented wire fields above.
