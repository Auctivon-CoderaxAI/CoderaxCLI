import { randomUUID } from "node:crypto";
import {
  ARTIFACT_ACTION_SET,
  ARTIFACT_ACTIONS,
  CAPABILITY_STATES,
  RESERVED_OPTIONS,
  SCHEDULE_ACTION_SET,
  SCHEDULE_ACTIONS,
  capabilityFamilyFor,
  stateLabel,
} from "./capability-catalog.js";
import {
  assertExecutable,
  findFamily,
  publicFamily,
  resolveRegistry,
} from "./capability-registry.js";
import { CoderaxError } from "./client.js";
import { EXIT } from "./exit.js";
import { formatBytes, singleLine, table } from "./format.js";
import {
  cancelTask,
  controlSchedule,
  coverageGaps,
  createEngineClient,
  createSchedule,
  decidePermission,
  deleteSchedule,
  engineHealth,
  followTask,
  getArtifact,
  getTask,
  listAgentsOrNull,
  listArtifacts,
  listPermissions,
  listSchedules,
  negotiate,
  submitWork,
  uploadArtifact,
  verifyOwner,
} from "./engine.js";
import {
  artifactPath,
  encodeBase64,
  inspectFile,
  prepareDestination,
  safeArtifactName,
  writeArtifactBytes,
} from "./file-transfer.js";

/**
 * Capability, artifact, schedule and permission commands.
 *
 * Every command resolves the authoritative handshake first. Nothing is executed
 * unless the engine reports the family's own capability, its prerequisites and
 * the operations it needs as available; a refusal names the exact prerequisite.
 * Execution is one `POST /v1/work` objective — the client never plans, infers,
 * renders or generates anything locally.
 */

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1000;

const AGENTS = new Set(["coderax", "opencode", "freebuff"]);

function usage(message) {
  throw new CoderaxError("USAGE", message);
}

function clientFor(ctx) {
  return createEngineClient({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
  });
}

function flag(ctx, name) {
  if (ctx.options?.has(name)) return ctx.options.get(name);
  if (ctx.flags?.has(name)) return ctx.flags.get(name);
  return undefined;
}

function optionText(ctx, name) {
  const value = flag(ctx, name);
  return typeof value === "string" ? value.trim() : "";
}

function truthy(value) {
  if (value === true) return true;
  if (typeof value === "string") return !["false", "0", "no", "off", ""].includes(value.toLowerCase());
  return false;
}

function emitJson(ctx, value) {
  ctx.out(JSON.stringify(value, null, 2));
}

async function registryFor(client) {
  const handshake = await negotiate(client);
  const agents = await listAgentsOrNull(client);
  const registry = resolveRegistry(handshake, { agents });
  return { handshake, registry, gaps: coverageGaps(handshake) };
}

function assertFeature(registry, key, operations = []) {
  const enabled = registry.capabilities[key];
  if (enabled !== true) {
    throw new CoderaxError(
      "CAPABILITY_NOT_AVAILABLE",
      enabled === undefined
        ? `the handshake does not report the ${key} capability; the deployment makes no claim about it`
        : `the engine reports ${key} as disabled or unavailable`,
      { details: { capability: key } },
    );
  }
  const published = new Set(registry.operations.map((operation) => operation.operationId));
  const missing = operations.filter((id) => !published.has(id));
  if (missing.length > 0) {
    throw new CoderaxError(
      "CAPABILITY_NOT_AVAILABLE",
      `the engine does not publish ${missing.join(", ")}`,
      { details: { capability: key, missing } },
    );
  }
}

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

function allowedOptionNames(entry) {
  const names = new Set(RESERVED_OPTIONS);
  names.add("file");
  names.add("prompt");
  names.add("reason");
  if (entry.question) names.add(entry.question.flag);
  for (const option of entry.options ?? []) names.add(option.flag);
  return names;
}

function validateOptions(ctx, entry) {
  const allowed = allowedOptionNames(entry);
  for (const name of ctx.options.keys()) {
    if (!allowed.has(name)) usage(`unknown option for ${entry.command}: --${name}`);
  }
  for (const option of entry.options ?? []) {
    const raw = flag(ctx, option.flag);
    if (raw === undefined || raw === true) continue;
    if (option.values && !option.values.includes(String(raw))) {
      usage(`--${option.flag} must be one of ${option.values.join(", ")}`);
    }
    if (option.integer) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < (option.min ?? Number.MIN_SAFE_INTEGER) || value > (option.max ?? Number.MAX_SAFE_INTEGER)) {
        usage(`--${option.flag} must be an integer between ${option.min} and ${option.max}`);
      }
    }
  }
}

function waitSettings(ctx) {
  const force = truthy(flag(ctx, "force"));
  const out = optionText(ctx, "out");
  if (force && out === "") usage("--force only authorizes replacing an explicit --out destination");
  const noWait = truthy(flag(ctx, "no-wait")) || flag(ctx, "wait") === "false" || flag(ctx, "wait") === false;
  const raw = optionText(ctx, "wait-timeout");
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  if (raw !== "") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_WAIT_TIMEOUT_MS || value > MAX_WAIT_TIMEOUT_MS) {
      usage(`--wait-timeout must be an integer between ${MIN_WAIT_TIMEOUT_MS} and ${MAX_WAIT_TIMEOUT_MS}`);
    }
    timeoutMs = value;
  }
  return { force, out, noWait, timeoutMs };
}

function parseModel(value) {
  if (value === "") return undefined;
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
    usage("--model must be <providerId>/<modelId>");
  }
  return { providerId: parts[0].trim(), modelId: parts[1].trim() };
}

function parseAgent(value) {
  if (value === "") return undefined;
  if (!AGENTS.has(value)) usage(`--agent must be one of ${[...AGENTS].join(", ")}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* discovery                                                           */
/* ------------------------------------------------------------------ */

export async function capabilities(ctx) {
  const client = clientFor(ctx);
  const { handshake, registry, gaps } = await registryFor(client);
  const wanted = optionText(ctx, "status");
  if (wanted !== "" && !Object.values(CAPABILITY_STATES).includes(wanted)) {
    usage(`--status must be one of ${Object.values(CAPABILITY_STATES).join(", ")}`);
  }
  const families = registry.families
    .filter((entry) => wanted === "" || entry.status === wanted)
    .map(publicFamily);

  if (ctx.json) {
    emitJson(ctx, {
      contract: registry.contract,
      counts: registry.counts,
      capabilities: registry.capabilities,
      operations: registry.operations,
      families,
      coverageGaps: gaps,
      agents: registry.agents?.agents ?? null,
    });
    return EXIT.OK;
  }

  ctx.out(
    `${registry.contract.engineName} ${registry.contract.engineVersion} · contract ${registry.contract.contractVersion} · SDK ${registry.contract.clientSdk}`,
  );
  ctx.out(`compatible: ${registry.contract.compatible ? "yes" : "no"}`);
  if (gaps.length > 0) ctx.out(`operations without an SDK method: ${gaps.join(", ")}`);
  ctx.out("");
  const rows = families.map((entry) => [
    entry.command,
    stateLabel(entry.status),
    entry.blockedBy ?? "—",
    singleLine(entry.detail, 90),
  ]);
  if (rows.length === 0) ctx.out("no capability matches that status");
  else ctx.out(table(rows, ["command", "status", "blocked by", "detail"]).join("\n"));
  const counts = Object.entries(registry.counts)
    .filter(([, value]) => value > 0)
    .map(([state, value]) => `${value} ${stateLabel(state)}`)
    .join(", ");
  ctx.out("");
  ctx.out(`${families.length} shown${counts ? ` · ${counts} overall` : ""}`);
  return EXIT.OK;
}

export async function readiness(ctx) {
  const client = clientFor(ctx);
  let owner;
  try {
    owner = await verifyOwner(client);
  } catch (error) {
    owner = null;
    if (ctx.json) {
      emitJson(ctx, {
        ready: false,
        owner: false,
        error: { code: error.code ?? "ERROR", message: singleLine(error.message, 300) },
        engine: null,
      });
      return EXIT.UNAVAILABLE;
    }
    ctx.err(`coderax: ${error.code ?? "ERROR"}: ${singleLine(error.message, 300)}`);
    return EXIT.UNAVAILABLE;
  }

  const { health, readiness: readyReport, readinessError, handshake } = await engineHealth(client);
  const registry = resolveRegistry(handshake, { agents: owner });
  const gaps = coverageGaps(handshake);
  const ready = readyReport === null ? false : readyReport.ready !== false;

  if (ctx.json) {
    emitJson(ctx, {
      ready,
      owner: true,
      engine: {
        name: registry.contract.engineName,
        version: registry.contract.engineVersion,
        contractVersion: handshake.contractVersion,
        eventSchemaVersion: handshake.eventSchemaVersion,
        chatStreamVersion: handshake.chatStreamVersion,
        operations: handshake.operations.length,
      },
      health,
      readiness: readyReport,
      readinessError,
      contract: registry.contract,
      counts: registry.counts,
      coverageGaps: gaps,
      agents: owner.agents,
    });
    return EXIT.OK;
  }

  ctx.out(`engine:     ${registry.contract.engineName} ${registry.contract.engineVersion}`);
  ctx.out(`contract:   ${handshake.contractVersion} (SDK ${registry.contract.clientSdk})`);
  ctx.out(`compatible: ${registry.contract.compatible ? "yes" : "no"}`);
  ctx.out(`ready:      ${ready ? "yes" : `no${readinessError ? ` (${singleLine(readinessError, 120)})` : ""}`}`);
  ctx.out(`owner:      verified by the engine`);
  ctx.out(`operations: ${handshake.operations.length}`);
  if (gaps.length > 0) ctx.out(`coverage:   ${gaps.length} operation(s) without an SDK method: ${gaps.join(", ")}`);
  ctx.out("");
  ctx.out(
    table(
      Object.entries(registry.counts).map(([state, value]) => [stateLabel(state), String(value)]),
      ["capability state", "families"],
    ).join("\n"),
  );
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* execution                                                           */
/* ------------------------------------------------------------------ */

function gatherInput(ctx, entry) {
  const args = [...ctx.args];
  let attachmentPath = null;
  if (entry.attachment) {
    // A required attachment is the first positional. An optional one is only
    // taken from --file, so `create-presentation "a deck about X"` is never
    // mistaken for a path.
    if (entry.attachment.required) {
      attachmentPath = args.shift() ?? optionText(ctx, "file");
      if (!attachmentPath) {
        usage(`${entry.command} requires a file: coderax ${entry.command} <file> [options]`);
      }
    } else {
      const explicit = optionText(ctx, "file");
      attachmentPath = explicit === "" ? null : explicit;
    }
  }
  const positional = args.join(" ").trim();
  const prompt = positional !== "" ? positional : optionText(ctx, "prompt");
  if (!entry.attachment && prompt === "") {
    usage(`${entry.command} requires text: coderax ${entry.command} "<request>" [options]`);
  }
  const input = {
    prompt,
    question: optionText(ctx, "question"),
    instruction: optionText(ctx, "instruction"),
    agent: parseAgent(optionText(ctx, "agent")),
    model: parseModel(optionText(ctx, "model")),
  };
  for (const option of entry.options ?? []) {
    const raw = optionText(ctx, option.flag);
    if (raw === "") continue;
    input[option.flag] = option.integer ? Number(raw) : raw;
  }
  return { input, attachmentPath };
}

function progressReporter(ctx) {
  let lastType = null;
  return (event) => {
    if (ctx.json) {
      // stdout stays a single JSON document; streaming events go to stderr.
      ctx.err(JSON.stringify(event));
      return;
    }
    if (event.type === "stream.truncated") {
      ctx.err("coderax: warning: the retained event window no longer contains the earlier cursor");
      return;
    }
    if (event.type === "text.delta") {
      const text = typeof event.payload?.text === "string" ? event.payload.text : "";
      if (text !== "") ctx.raw(text);
      return;
    }
    if (event.type === "step.started") {
      ctx.out(`\nstep: ${singleLine(event.payload?.title ?? event.payload?.id ?? "running", 120)}`);
      lastType = event.type;
      return;
    }
    if (event.type === "approval.required") {
      const request = event.payload?.request ?? event.payload;
      ctx.out(
        `\napproval required: ${singleLine(request?.description ?? "the engine is waiting for an owner decision", 160)}`,
      );
      if (typeof request?.requestId === "string") {
        ctx.out(`  coderax permissions approve ${event.taskId} ${request.requestId}`);
      }
      return;
    }
    if (event.type === "tool.call" || event.type === "tool.result" || event.type === "file.edit") {
      const label = event.payload?.name ?? event.payload?.path ?? event.type;
      ctx.err(`coderax: ${event.type}: ${singleLine(label, 120)}`);
      return;
    }
    if (lastType === "text.delta" && event.type.startsWith("task.")) ctx.out("");
  };
}

function artifactRows(artifacts) {
  return artifacts.map((artifact) => [
    artifact.artifactId,
    safeArtifactName(artifact.path),
    artifact.mediaType,
    formatBytes(artifact.bytes),
    artifact.digest.replace(/^sha256:/, "").slice(0, 12),
  ]);
}

async function downloadOne(ctx, client, taskId, artifact) {
  const force = truthy(flag(ctx, "force"));
  const out = optionText(ctx, "out");
  const prepared = await prepareDestination({
    out: out === "" ? undefined : out,
    defaultName: artifact.path,
    cwd: ctx.cwd,
    force,
  });
  const content = await getArtifact(client, taskId, artifact.artifactId);
  const meta = content.artifact;
  if (meta.artifactId !== artifact.artifactId || meta.taskId !== taskId) {
    throw new CoderaxError(
      "ARTIFACT_INTEGRITY_FAILED",
      "the engine returned content for a different task or artifact",
    );
  }
  if (meta.digest !== artifact.digest || meta.bytes !== artifact.bytes) {
    throw new CoderaxError(
      "ARTIFACT_INTEGRITY_FAILED",
      "the content descriptor does not match the artifact metadata; refusing to write it",
    );
  }
  const written = await writeArtifactBytes({
    destination: prepared.destination,
    force: prepared.force,
    expectedSha256: meta.digest,
    expectedBytes: meta.bytes,
    content: content.content,
    encoding: content.encoding,
  });
  return { ...written, artifactId: meta.artifactId, mediaType: meta.mediaType };
}

export async function runCapability(command, ctx) {
  const entry = capabilityFamilyFor(command);
  if (entry === null) usage(`unknown capability: ${command}`);
  validateOptions(ctx, entry);

  if (entry.mode === "upload") return runUpload(ctx, entry);

  const client = clientFor(ctx);
  const { registry } = await registryFor(client);
  const resolved = findFamily(registry, entry.id);
  assertExecutable(resolved);

  const { input, attachmentPath } = gatherInput(ctx, entry);
  const { force, out, noWait, timeoutMs } = waitSettings(ctx);

  let attachment = null;
  if (attachmentPath !== null) {
    attachment = await inspectFile(attachmentPath, {
      mimeTypes: entry.attachment.mimeTypes,
      maxBytes: entry.attachment.maxBytes,
      cwd: ctx.cwd,
    });
  }

  const objective = String(
    entry.objective({
      ...input,
      attachmentName: attachment?.name ?? "",
      attachmentMediaType: attachment?.mimeType ?? "",
      attachmentSha256: attachment?.sha256 ?? "",
    }) ?? "",
  ).trim();
  if (objective === "") usage(`${entry.command} produced an empty objective`);

  const request = {
    objective,
    mode: "cloud",
    requireApproval: true,
    idempotencyKey: `cli:${Date.now()}:${randomUUID()}`,
  };
  if (input.agent !== undefined) request.agent = input.agent;
  if (input.model !== undefined) request.model = input.model;
  const conversation = optionText(ctx, "conversation");
  if (conversation !== "") request.conversationId = conversation;

  const accepted = await submitWork(client, request);

  let storedArtifact = null;
  if (attachment !== null) {
    try {
      storedArtifact = await uploadArtifact(client, accepted.taskId, {
        path: artifactPath(attachment.name),
        mediaType: attachment.mimeType,
        encoding: "base64",
        content: encodeBase64(attachment.buffer),
      });
    } catch (error) {
      // The task was accepted before its input existed. Do not leave it running.
      await cancelTask(client, accepted.taskId, "attachment upload failed").catch(() => {});
      throw new CoderaxError(
        error.code ?? "UPLOAD_FAILED",
        `the attachment could not be stored, so task ${accepted.taskId} was cancelled: ${singleLine(error.message, 200)}`,
        { details: { taskId: accepted.taskId, attachment: attachment.name } },
      );
    }
    if (storedArtifact.digest !== `sha256:${attachment.sha256}` || storedArtifact.bytes !== attachment.bytes) {
      await cancelTask(client, accepted.taskId, "attachment digest mismatch").catch(() => {});
      throw new CoderaxError(
        "ARTIFACT_INTEGRITY_FAILED",
        `the engine reported ${storedArtifact.digest} for ${attachment.name}, not the local ` +
          `sha256:${attachment.sha256}; task ${accepted.taskId} was cancelled`,
        { details: { taskId: accepted.taskId } },
      );
    }
  }

  if (noWait) {
    if (ctx.json) {
      emitJson(ctx, {
        accepted,
        capability: publicFamily(resolved),
        attachment: storedArtifact,
        waited: false,
      });
    } else {
      ctx.out(`task ${accepted.taskId} accepted (${accepted.state})`);
      ctx.out(`events: ${accepted.eventsPath}`);
      if (storedArtifact !== null) {
        ctx.out(`artifact: ${storedArtifact.artifactId} (${safeArtifactName(storedArtifact.path)})`);
      }
      ctx.out("not waiting (--no-wait); the task continues on the engine");
    }
    return EXIT.OK;
  }

  const deadline = Date.now() + timeoutMs;
  const onEvent = progressReporter(ctx);
  let followed;
  try {
    followed = await followTask(client, accepted, {
      onEvent,
      signal: ctx.signal,
      deadline,
    });
  } catch (error) {
    if (error.code === "WAIT_TIMEOUT" && ctx.json) {
      emitJson(ctx, {
        accepted,
        capability: publicFamily(resolved),
        attachment: storedArtifact,
        waited: false,
        timeout: true,
        detail: error.message,
      });
      return EXIT.NETWORK;
    }
    throw error;
  }

  const task = followed.task;
  const artifacts = (await listArtifacts(client, task.taskId)).artifacts;
  const summary = task.result?.summary ?? null;
  const failure = task.failure ?? null;

  let downloaded = null;
  if (out !== "") {
    if (artifacts.length === 0) {
      throw new CoderaxError(
        "ARTIFACT_MISSING",
        `task ${task.taskId} finished ${task.state} with no artifact to download`,
        { details: { taskId: task.taskId } },
      );
    }
    if (artifacts.length > 1 && !ctx.json) {
      ctx.err(`coderax: task produced ${artifacts.length} artifacts; downloading the first`);
    }
    downloaded = await downloadOne(ctx, client, task.taskId, artifacts[0]);
  }

  if (ctx.json) {
    emitJson(ctx, {
      accepted,
      capability: publicFamily(resolved),
      attachment: storedArtifact,
      task,
      artifacts,
      downloaded,
      events: followed.events,
      waited: true,
    });
  } else {
    ctx.out("");
    ctx.out(`task ${task.taskId}: ${task.state}`);
    if (summary !== null && summary !== "") ctx.out(summary);
    if (failure !== null) ctx.out(`${failure.code}${failure.detail ? `: ${failure.detail}` : ""}`);
    if (artifacts.length > 0) {
      ctx.out("");
      ctx.out(
        table(artifactRows(artifacts), ["artifact", "name", "type", "size", "sha256"]).join("\n"),
      );
      ctx.out("");
      ctx.out(`download: coderax artifacts download <artifact> --out <path>`);
    }
    if (downloaded !== null) {
      ctx.out(`wrote ${downloaded.path} (${formatBytes(downloaded.bytes)}, sha256:${downloaded.sha256})`);
    }
    if (force && downloaded === null) ctx.err("coderax: --force had no destination to replace");
  }

  if (task.state !== "completed") return EXIT.ERROR;
  return EXIT.OK;
}

export async function runCapabilityGeneric(ctx) {
  const name = ctx.args[0];
  if (!name) usage("capability run requires an id or command; run `coderax capabilities`");
  const entry = capabilityFamilyFor(name);
  if (entry === null) usage(`unknown capability: ${name}`);
  return runCapability(entry.command, { ...ctx, args: ctx.args.slice(1) });
}

async function runUpload(ctx, entry) {
  const taskId = optionText(ctx, "task");
  if (taskId === "") {
    usage(
      "upload requires --task <taskId>: the authoritative artifact service stores bytes on an owner task " +
        "(POST /v1/work/{taskId}/artifacts)",
    );
  }
  const filePath = ctx.args[0];
  if (!filePath) usage(`upload requires a file: coderax upload <file> --task <taskId>`);
  validateOptions(ctx, entry);

  const file = await inspectFile(filePath, {
    mimeTypes: entry.attachment.mimeTypes,
    maxBytes: entry.attachment.maxBytes,
    cwd: ctx.cwd,
  });

  const client = clientFor(ctx);
  const { registry } = await registryFor(client);
  const resolved = findFamily(registry, entry.id);
  assertExecutable(resolved);

  const record = await uploadArtifact(client, taskId, {
    path: artifactPath(file.name),
    mediaType: file.mimeType,
    encoding: "base64",
    content: encodeBase64(file.buffer),
  });

  if (record.digest !== `sha256:${file.sha256}` || record.bytes !== file.bytes) {
    throw new CoderaxError(
      "ARTIFACT_INTEGRITY_FAILED",
      `the engine reported ${record.digest} for ${file.name}, not the local sha256:${file.sha256}`,
      { details: { taskId } },
    );
  }

  if (ctx.json) {
    emitJson(ctx, { artifact: record, taskId, localSha256: file.sha256, verified: true });
  } else {
    ctx.out(`stored ${safeArtifactName(record.path)} on task ${taskId}`);
    ctx.out(`artifact: ${record.artifactId}`);
    ctx.out(`bytes:    ${record.bytes}`);
    ctx.out(`digest:   ${record.digest} (matches local sha256)`);
  }
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* artifacts                                                           */
/* ------------------------------------------------------------------ */

export async function artifacts(ctx) {
  const action = ctx.args[0] ?? "list";
  if (!ARTIFACT_ACTION_SET.has(action)) {
    usage(`artifacts requires one of ${ARTIFACT_ACTIONS.join(", ")}`);
  }
  const client = clientFor(ctx);
  const { registry } = await registryFor(client);
  assertFeature(registry, "artifacts");

  if (action === "list") {
    const taskId = optionText(ctx, "task") || ctx.args[1] || "";
    if (taskId === "") usage("artifacts list requires --task <taskId>");
    const list = await listArtifacts(client, taskId);
    if (ctx.json) {
      emitJson(ctx, { taskId, artifacts: list.artifacts });
      return EXIT.OK;
    }
    if (list.artifacts.length === 0) {
      ctx.out(`task ${taskId} has no artifacts`);
      return EXIT.OK;
    }
    ctx.out(
      table(artifactRows(list.artifacts), ["artifact", "name", "type", "size", "sha256"]).join("\n"),
    );
    return EXIT.OK;
  }

  const artifactId = ctx.args[1];
  if (!artifactId) usage(`artifacts ${action} requires an artifact id`);
  const taskId = optionText(ctx, "task");
  if (taskId === "") {
    usage(
      `artifacts ${action} requires --task <taskId>: contract 1.1.0 addresses artifact content by task ` +
        "(GET /v1/work/{taskId}/artifacts/{artifactId})",
    );
  }

  const content = await getArtifact(client, taskId, artifactId);
  const record = content.artifact;
  if (record.taskId !== taskId) {
    throw new CoderaxError("ARTIFACT_INTEGRITY_FAILED", "the engine returned an artifact from a different task");
  }

  if (action === "inspect") {
    if (ctx.json) {
      emitJson(ctx, { artifact: record, encoding: content.encoding, contentBytes: content.content.length });
      return EXIT.OK;
    }
    ctx.out(`artifact: ${record.artifactId}`);
    ctx.out(`task:     ${record.taskId}`);
    ctx.out(`path:     ${record.path}`);
    ctx.out(`type:     ${record.mediaType}`);
    ctx.out(`bytes:    ${record.bytes}`);
    ctx.out(`digest:   ${record.digest}`);
    ctx.out(`origin:   ${record.origin}`);
    ctx.out(`created:  ${record.createdAt}`);
    return EXIT.OK;
  }

  const written = await downloadOne(ctx, client, taskId, record);
  if (ctx.json) emitJson(ctx, { artifact: record, encoding: content.encoding, download: written });
  else ctx.out(`wrote ${written.path} (${formatBytes(written.bytes)}, sha256:${written.sha256})`);
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* schedules                                                           */
/* ------------------------------------------------------------------ */

const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const MAX_SCHEDULE_INTERVAL_MS = 604_800_000;

function scheduleRows(schedules) {
  return schedules.map((schedule) => [
    schedule.scheduleId,
    schedule.enabled ? "enabled" : "paused",
    schedule.nextRunAt ?? "—",
    `${schedule.intervalMs} ms`,
    `${schedule.runs} run${schedule.runs === 1 ? "" : "s"}, ${schedule.skipped} skipped`,
    singleLine(schedule.objective, 60),
  ]);
}

export async function schedules(ctx) {
  const action = ctx.args[0] ?? "list";
  if (!SCHEDULE_ACTION_SET.has(action)) usage(`schedules requires one of ${SCHEDULE_ACTIONS.join(", ")}`);
  const client = clientFor(ctx);
  const { registry } = await registryFor(client);

  if (action === "list") {
    assertFeature(registry, "schedules", ["listSchedules"]);
    const list = await listSchedules(client);
    if (ctx.json) {
      emitJson(ctx, list);
      return EXIT.OK;
    }
    if (list.schedules.length === 0) {
      ctx.out("no schedules");
      return EXIT.OK;
    }
    ctx.out(
      table(scheduleRows(list.schedules), [
        "schedule",
        "state",
        "next run",
        "interval",
        "history",
        "objective",
      ]).join("\n"),
    );
    return EXIT.OK;
  }

  if (action === "create") {
    assertFeature(registry, "schedules", ["createSchedule"]);
    const objective = ctx.args.slice(1).join(" ").trim();
    if (objective === "") usage("schedules create requires an objective");
    const rawInterval = optionText(ctx, "interval-ms") || optionText(ctx, "every");
    if (rawInterval === "") {
      usage("schedules create requires --interval-ms <milliseconds> (minimum 60000)");
    }
    const intervalMs = Number(rawInterval);
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < MIN_SCHEDULE_INTERVAL_MS ||
      intervalMs > MAX_SCHEDULE_INTERVAL_MS
    ) {
      usage(
        `--interval-ms must be an integer between ${MIN_SCHEDULE_INTERVAL_MS} and ${MAX_SCHEDULE_INTERVAL_MS}`,
      );
    }
    const request = { objective, intervalMs };
    const startAt = optionText(ctx, "start-at") || optionText(ctx, "at");
    if (startAt !== "") {
      if (!Number.isFinite(Date.parse(startAt))) usage("--start-at must be an ISO-8601 time");
      request.startAt = new Date(startAt).toISOString();
    }
    const agent = parseAgent(optionText(ctx, "agent"));
    if (agent !== undefined) request.agent = agent;
    const schedule = await createSchedule(client, request);
    if (ctx.json) emitJson(ctx, { schedule });
    else {
      ctx.out(`scheduled ${schedule.scheduleId} every ${schedule.intervalMs} ms`);
      ctx.out(`next run: ${schedule.nextRunAt ?? "paused"}`);
    }
    return EXIT.OK;
  }

  const scheduleId = ctx.args[1];
  if (!scheduleId) usage(`schedules ${action} requires a schedule id`);

  if (action === "delete") {
    assertFeature(registry, "schedules", ["deleteSchedule"]);
    const result = await deleteSchedule(client, scheduleId);
    if (ctx.json) emitJson(ctx, { result });
    else ctx.out(`schedule ${result.scheduleId}: ${result.outcome}`);
    return EXIT.OK;
  }

  assertFeature(registry, "schedules", ["controlSchedule"]);
  const result = await controlSchedule(client, scheduleId, action);
  if (ctx.json) emitJson(ctx, { result });
  else {
    ctx.out(
      `schedule ${result.scheduleId}: ${result.enabled ? "enabled" : "paused"} (${result.outcome})`,
    );
  }
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* permissions                                                         */
/* ------------------------------------------------------------------ */

export async function permissions(ctx) {
  const action = ctx.args[0] ?? "list";
  const client = clientFor(ctx);
  const { registry } = await registryFor(client);

  if (action === "list") {
    assertFeature(registry, "permissions", ["listPermissions"]);
    const taskId = optionText(ctx, "task") || ctx.args[1] || "";
    if (taskId === "") {
      usage("permissions list requires --task <taskId>: contract 1.1.0 addresses permissions by task");
    }
    const list = await listPermissions(client, taskId);
    if (ctx.json) {
      emitJson(ctx, { taskId, ...list });
      return EXIT.OK;
    }
    const pending = list.requests.filter((request) => request.decision === "pending");
    if (pending.length === 0) {
      ctx.out("no pending permission requests");
      return EXIT.OK;
    }
    ctx.out(
      table(
        pending.map((request) => [
          request.taskId,
          request.requestId,
          request.scope,
          singleLine(request.resource, 40),
          singleLine(request.description, 60),
        ]),
        ["task", "request", "scope", "resource", "description"],
      ).join("\n"),
    );
    return EXIT.OK;
  }

  if (action !== "approve" && action !== "deny") {
    usage("permissions requires list, approve or deny");
  }
  assertFeature(registry, "permissions", ["decidePermission"]);
  const taskId = ctx.args[1];
  const requestId = ctx.args[2];
  if (!taskId || !requestId) usage(`permissions ${action} requires <taskId> <requestId>`);
  const reason = optionText(ctx, "reason");
  const list = await decidePermission(client, taskId, {
    requestId,
    decision: action === "approve" ? "approved" : "denied",
    ...(reason === "" ? {} : { reason }),
  });
  if (ctx.json) {
    emitJson(ctx, list);
    return EXIT.OK;
  }
  const decided = list.requests.find((request) => request.requestId === requestId);
  ctx.out(`${requestId}: ${decided?.decision ?? (action === "approve" ? "approved" : "denied")}`);
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* reattach                                                            */
/* ------------------------------------------------------------------ */

export async function task(ctx) {
  const taskId = ctx.args[0];
  if (!taskId) usage("task requires a task id");
  const client = clientFor(ctx);
  const record = await getTask(client, taskId);
  const list = await listArtifacts(client, taskId).catch(() => ({ artifacts: [] }));
  if (ctx.json) {
    emitJson(ctx, { task: record, artifacts: list.artifacts });
    return record.state === "completed" ? EXIT.OK : EXIT.ERROR;
  }
  ctx.out(`task ${record.taskId}: ${record.state}`);
  if (record.result?.summary) ctx.out(record.result.summary);
  if (record.failure) ctx.out(`${record.failure.code}${record.failure.detail ? `: ${record.failure.detail}` : ""}`);
  if (list.artifacts.length > 0) {
    ctx.out("");
    ctx.out(table(artifactRows(list.artifacts), ["artifact", "name", "type", "size", "sha256"]).join("\n"));
  }
  return record.state === "completed" ? EXIT.OK : EXIT.ERROR;
}
