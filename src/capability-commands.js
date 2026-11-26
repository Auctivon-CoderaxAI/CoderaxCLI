import { basename } from "node:path";
import {
  CAPABILITY_STATUSES,
  EXECUTABLE_STATUS,
  capabilityForCommand,
  statusLabel,
} from "./capability-catalog.js";
import {
  CAPABILITY_CONTRACT_VERSION,
  assertExecutable,
  decodeRegistry,
  findCapability,
  publicCapability,
  unpublishedRegistry,
} from "./capability-registry.js";
import { CoderaxError, formatJson, redact, redactValue } from "./client.js";
import { EXIT } from "./exit.js";
import {
  inspectFile,
  normalizeDigest,
  prepareDestination,
  writeDownload,
  MAX_DOWNLOAD_BYTES,
} from "./file-transfer.js";
import { formatBytes, singleLine, table } from "./format.js";
import {
  assertArtifactId,
  assertConversationId,
  assertProjectId,
  createWorkflowClient,
  isTerminalState,
} from "./sdk.js";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const CONTEXT_OPTIONS = new Set(["project", "conversation"]);
const TRANSPORT_OPTIONS = new Set([
  "force",
  "json",
  "no-wait",
  "out",
  "stream",
  "wait-timeout",
]);

function requireBase(ctx) {
  if (!ctx.settings.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
}

function requireAuth(ctx) {
  if (!ctx.settings.token) {
    throw new CoderaxError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }
}

function clientFor(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  return createWorkflowClient({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
  });
}

function option(ctx, name) {
  if (ctx.options?.has(name)) return ctx.options.get(name);
  if (ctx.flags?.has(name)) return ctx.flags.get(name);
  return undefined;
}

function optionText(ctx, name) {
  const value = option(ctx, name);
  if (value === undefined) return undefined;
  if (value === true) {
    throw new CoderaxError("USAGE", `--${name} requires a value`);
  }
  return String(value);
}

function optionNames(ctx) {
  return [...new Set([...(ctx.options?.keys() ?? []), ...(ctx.flags?.keys() ?? [])])];
}

function rejectUnknownOptions(ctx, allowed) {
  const unexpected = optionNames(ctx).filter(
    (name) =>
      !allowed.has(name) &&
      !["base-url", "chat-path", "data", "endpoint", "help", "json", "model", "no-color", "timeout", "token", "url", "version"].includes(name),
  );
  if (unexpected.length > 0) {
    throw new CoderaxError(
      "USAGE",
      `unknown option for ${ctx.command}: --${unexpected[0]}. Supported options: ${[...allowed].sort().join(", ")}`,
    );
  }
}

function jsonOut(ctx, value) {
  ctx.out(formatJson(redactValue(value, ctx.settings.token)));
}

function safeText(ctx, value, limit = 300) {
  // Redact before truncating: a cut inside the token would otherwise leave an
  // unredactable prefix in the output.
  return singleLine(redact(String(value ?? ""), ctx.settings.token), limit);
}

function report(ctx, message) {
  if (!ctx.json) ctx.err(redact(message, ctx.settings.token));
}

function reportEvent(ctx, event) {
  if (!ctx.stream) return;
  if (ctx.json) {
    ctx.out(`${JSON.stringify(redactValue({ type: "event", event }, ctx.settings.token))}\n`);
    return;
  }
  const payload = event?.payload ?? {};
  const kind = String(event?.type ?? "event");
  if (kind === "step.started" || kind === "step.completed") {
    report(ctx, `${kind === "step.started" ? "\u25b8" : "\u2713"} step ${safeText(ctx, payload.title ?? payload.stepId, 120)}`);
  } else if (kind === "tool.call") {
    report(ctx, `\u25b8 tool ${safeText(ctx, payload.tool, 80)}`);
  } else if (kind === "tool.result") {
    report(ctx, `${payload.ok === false ? "\u2717" : "\u2713"} tool ${safeText(ctx, payload.tool, 80)}`);
  } else if (kind === "text.delta") {
    report(ctx, safeText(ctx, payload.text, 2000));
  } else if (kind === "approval.required") {
    report(ctx, `\u26a0 approval required: ${safeText(ctx, payload.description, 300)} (${safeText(ctx, payload.requestId, 120)})`);
  } else if (kind.startsWith("task.")) {
    report(ctx, `\u2022 ${kind}`);
  }
}

async function loadRegistry(ctx, client) {
  try {
    const response = await client.capabilities();
    return decodeRegistry(response.json);
  } catch (error) {
    if (error.code === "HTTP_404" || error.code === "HTTP_405" || error.code === "HTTP_501") {
      return unpublishedRegistry(
        "the engine does not publish GET /v1/capabilities; every capability is blocked until it does",
      );
    }
    throw error;
  }
}

function capabilityRows(registry, ctx) {
  return registry.capabilities.map((capability) => [
    safeText(ctx, capability.title, 80),
    safeText(ctx, capability.command, 40),
    capability.status,
    safeText(ctx, capability.detail || capability.reason, 90),
  ]);
}

export async function capabilities(ctx) {
  rejectUnknownOptions(ctx, new Set(["status"]));
  const status = optionText(ctx, "status");
  if (status !== undefined && !CAPABILITY_STATUSES.includes(status)) {
    throw new CoderaxError(
      "USAGE",
      `--status must be one of: ${CAPABILITY_STATUSES.join(", ")}`,
    );
  }
  const client = clientFor(ctx);
  const registry = await loadRegistry(ctx, client);
  const visible = status === undefined
    ? registry.capabilities
    : registry.capabilities.filter((capability) => capability.status === status);

  if (ctx.json) {
    jsonOut(ctx, {
      contractVersion: registry.contractVersion,
      clientContractVersion: CAPABILITY_CONTRACT_VERSION,
      registryVersion: registry.registryVersion,
      source: registry.source,
      published: registry.published,
      capabilities: visible.map(publicCapability),
      artifacts: registry.artifacts,
    });
  } else {
    const rows = visible.map((capability) => [
      safeText(ctx, capability.title, 80),
      safeText(ctx, capability.command, 40),
      statusLabel(capability.status),
      safeText(ctx, capability.detail || capability.reason, 90),
    ]);
    ctx.out(table(rows, ["CAPABILITY", "COMMAND", "STATUS", "DETAIL"]).join("\n"));
    ctx.out("");
    if (registry.published) {
      const available = registry.capabilities.filter((item) => item.status === EXECUTABLE_STATUS).length;
      ctx.out(
        `${available}/${registry.capabilities.length} capabilities are available. Only available capabilities execute; the rest report the engine's reason.`,
      );
      if (registry.artifacts.status !== "available") {
        ctx.out(
          `Artifacts: ${registry.artifacts.status} (${safeText(ctx, registry.artifacts.reason, 120)}). ${safeText(ctx, registry.artifacts.detail, 200)}`.trim(),
        );
      }
    } else {
      ctx.out("The engine publishes no capability registry, so no capability is advertised as operational.");
    }
  }
  return registry.published ? EXIT.OK : EXIT.UNAVAILABLE;
}

export async function readiness(ctx) {
  rejectUnknownOptions(ctx, new Set());
  const client = clientFor(ctx);
  let engine;
  try {
    engine = await client.readiness();
  } catch (error) {
    if (error.code === "HTTP_404" || error.code === "HTTP_405") {
      engine = { body: { ready: false, missing: ["/v1/ready is not published"], checks: [] } };
    } else {
      throw error;
    }
  }
  const registry = await loadRegistry(ctx, client);
  const available = registry.capabilities.filter((capability) => capability.status === EXECUTABLE_STATUS);
  const result = {
    ready: engine.body.ready === true,
    clientContractVersion: CAPABILITY_CONTRACT_VERSION,
    published: registry.published,
    missing: Array.isArray(engine.body.missing) ? engine.body.missing : [],
    checks: Array.isArray(engine.body.checks) ? engine.body.checks : [],
    capabilities: {
      available: available.length,
      total: registry.capabilities.length,
      items: registry.capabilities.map(publicCapability),
    },
    artifacts: registry.artifacts,
  };

  if (ctx.json) {
    jsonOut(ctx, result);
  } else {
    ctx.out(`engine: ${result.ready ? "ready" : "not ready"}`);
    if (!result.published) ctx.out("capability registry: not published");
    if (result.missing.length > 0) {
      ctx.out(`missing: ${safeText(ctx, result.missing.join(", "), 500)}`);
    }
    ctx.out(`capabilities: ${result.capabilities.available}/${result.capabilities.total} available`);
    const rows = capabilityRows(registry, ctx);
    ctx.out("");
    ctx.out(table(rows, ["CAPABILITY", "COMMAND", "STATUS", "DETAIL"]).join("\n"));
  }
  return result.ready && registry.published ? EXIT.OK : EXIT.UNAVAILABLE;
}

function normalizeBoolean(value, name) {
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${name} must be true or false`);
}

function normalizeValue(input, raw) {
  if (input.type === "boolean") return normalizeBoolean(raw, input.name);
  if (raw === true) {
    throw new CoderaxError("USAGE", `--${input.name} requires a value`);
  }
  if (input.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} must be a number`);
    }
    if (input.integer === true && !Number.isInteger(value)) {
      throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} must be an integer`);
    }
    if (input.min !== undefined && value < input.min) {
      throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} must be at least ${input.min}`);
    }
    if (input.max !== undefined && value > input.max) {
      throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} must be at most ${input.max}`);
    }
    return value;
  }
  if (input.type === "enum") {
    const value = String(raw).trim();
    if (!input.values.includes(value)) {
      throw new CoderaxError(
        "CAPABILITY_INPUT_INVALID",
        `--${input.name} must be one of: ${input.values.join(", ")}`,
      );
    }
    return value;
  }
  const value = String(raw).trim();
  if (value === "") {
    throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} must not be empty`);
  }
  if (input.type === "text" && value.length > 200000) {
    throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} exceeds the 200,000 character limit`);
  }
  if (input.type === "string" && value.length > 1000) {
    throw new CoderaxError("CAPABILITY_INPUT_INVALID", `--${input.name} exceeds the 1,000 character limit`);
  }
  return value;
}

function usageFor(capability) {
  const positional = capability.primary ? ` <${capability.primary}>` : "";
  const options = capability.inputs
    .filter((item) => item.name !== capability.primary)
    .map((item) => ` [--${item.name} <${item.type}>]`)
    .join("");
  return `coderax ${capability.command}${positional}${options} [--project <id>] [--json]`;
}

/**
 * Resolve inputs strictly against the registry's declaration. A capability may
 * not receive an option the engine did not publish.
 */
async function collectInputs(ctx, capability, client) {
  // Validate project and conversation references before any file leaves the
  // machine, so an invalid association cannot leave an orphaned upload.
  const { projectId, conversationId } = projectAndConversation(ctx);
  const declared = new Map(capability.inputs.map((item) => [item.name, item]));
  const transport = capability.command === "upload" ? new Set() : TRANSPORT_OPTIONS;
  const allowed = new Set([...declared.keys(), ...CONTEXT_OPTIONS, ...transport]);
  rejectUnknownOptions(ctx, allowed);

  const raw = new Map();
  for (const name of optionNames(ctx)) {
    if (declared.has(name)) {
      const value = option(ctx, name);
      raw.set(name, value);
    }
  }

  const positionals = [...(ctx.args ?? [])];
  if (capability.primary) {
    const primary = declared.get(capability.primary);
    if (!primary) {
      throw new CoderaxError(
        "CAPABILITY_REGISTRY_INVALID",
        `capability ${capability.id} binds a positional to an input it does not declare`,
      );
    }
    if (positionals.length > 0) {
      if (raw.has(primary.name)) {
        throw new CoderaxError(
          "USAGE",
          `provide ${primary.name} either as an argument or as --${primary.name}, not both`,
        );
      }
      if (primary.type === "file") {
        if (positionals.length > 1) {
          throw new CoderaxError("USAGE", `${capability.command} accepts one file argument`);
        }
        raw.set(primary.name, positionals[0]);
      } else {
        raw.set(primary.name, positionals.join(" "));
      }
    }
  } else if (positionals.length > 0) {
    throw new CoderaxError(
      "USAGE",
      `${capability.command} takes no positional arguments; use ${[...declared.keys()].map((name) => `--${name}`).join(", ") || "no options"}`,
    );
  }

  const values = {};
  for (const input of capability.inputs) {
    let value = raw.get(input.name);
    if (value === undefined) {
      if (input.default !== undefined) {
        value = input.default;
      } else if (input.required && (input.type === "text" || input.type === "string")) {
        if (!ctx.stdinIsTTY) {
          const piped = (await ctx.readSecret()).trim();
          if (piped !== "") value = piped;
        }
      }
    }
    if (value === undefined) {
      if (input.required) {
        throw new CoderaxError(
          "USAGE",
          `missing required ${input.name}; usage: ${usageFor(capability)}`,
        );
      }
      continue;
    }
    if (input.type === "file") {
      if (value === true) {
        throw new CoderaxError("USAGE", `--${input.name} requires a file path`);
      }
      const inspected = await inspectFile(String(value), {
        mimeTypes: input.mimeTypes ?? [],
        maxBytes: input.maxBytes,
        cwd: ctx.cwd,
      });
      report(
        ctx,
        `uploading ${inspected.name} (${formatBytes(inspected.bytes)}, sha256 ${inspected.sha256.slice(0, 12)}\u2026)`,
      );
      const uploaded = await client.uploadFile({
        file: inspected,
        projectId,
        conversationId,
      });
      values[input.name] = uploaded;
      report(
        ctx,
        `uploaded ${uploaded.name} as ${uploaded.uploadId}${uploaded.expiresAt ? ` (expires ${uploaded.expiresAt})` : ""}`,
      );
    } else {
      values[input.name] = normalizeValue(input, value);
    }
  }
  return values;
}

function projectAndConversation(ctx) {
  const projectId = optionText(ctx, "project");
  const conversationId = optionText(ctx, "conversation");
  return {
    projectId: projectId === undefined ? undefined : assertProjectId(projectId),
    conversationId: conversationId === undefined ? undefined : assertConversationId(conversationId),
  };
}

function booleanFlag(value, name) {
  if (value === undefined) return false;
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  throw new CoderaxError("USAGE", `--${name} must be true or false`);
}

function waitSettings(ctx) {
  const noWait = booleanFlag(option(ctx, "no-wait"), "no-wait");
  const stream = booleanFlag(option(ctx, "stream"), "stream");
  if (noWait && stream) {
    throw new CoderaxError("USAGE", "--stream requires waiting; drop --no-wait");
  }
  if (booleanFlag(option(ctx, "force"), "force") && option(ctx, "out") === undefined) {
    throw new CoderaxError("USAGE", "--force requires --out <path>");
  }
  const raw = optionText(ctx, "wait-timeout");
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  if (raw !== undefined) {
    timeoutMs = Number(raw);
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw new CoderaxError(
        "USAGE",
        `--wait-timeout must be an integer between ${MIN_WAIT_TIMEOUT_MS} and ${MAX_WAIT_TIMEOUT_MS} milliseconds`,
      );
    }
  }
  return { wait: !noWait, stream, timeoutMs };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CoderaxError("CANCELLED", "wait cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForTask({ client, accepted, ctx, timeoutMs }) {
  const taskId = accepted.taskId;
  const deadline = Date.now() + timeoutMs;
  let lastState = accepted.state;
  let lastSeq = 0;
  let task = null;

  const remaining = () => Math.max(1, deadline - Date.now());

  try {
    for await (const event of client.events({
      taskId,
      after: lastSeq,
      signal: AbortSignal.timeout(remaining()),
    })) {
      const seq = Number.isSafeInteger(event.seq) ? event.seq : lastSeq;
      lastSeq = Math.max(lastSeq, seq);
      reportEvent(ctx, event);
      if (typeof event.type === "string" && event.type.startsWith("task.")) {
        // Terminal events end the generator; a task snapshot is still read
        // afterwards because the event does not carry the full result.
        if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(event.type)) {
          break;
        }
      }
    }
  } catch (error) {
    // Events are an optimization over the durable task snapshot. A missing or
    // interrupted stream must not fail a task the engine is still running.
    const recoverable = new Set([
      "HTTP_404",
      "HTTP_405",
      "HTTP_501",
      "REQUEST_FAILED",
      "REQUEST_TIMEOUT",
    ]);
    // The stream is bounded by the local wait deadline. Its abort is a deadline
    // signal, not an owner cancellation, so fall through to the task snapshot.
    const deadlineReached =
      error.code === "CANCELLED" && !ctx.signal?.aborted && Date.now() >= deadline - 100;
    if (!deadlineReached) {
      if (!recoverable.has(error.code) || ctx.signal?.aborted) throw error;
      report(ctx, `event stream unavailable (${error.code}); falling back to task polling`);
    }
  }

  for (;;) {
    try {
      task = await client.task(taskId);
    } catch (error) {
      // Only a transient transport or server-availability failure is retried.
      // Authentication, contract and not-found errors surface immediately.
      const retryable = new Set([
        "REQUEST_FAILED",
        "REQUEST_TIMEOUT",
        "HTTP_500",
        "HTTP_502",
        "HTTP_503",
        "HTTP_504",
      ]);
      if (!retryable.has(error.code)) throw error;
      task = null;
    }
    if (task !== null) {
      if (task.state !== lastState) {
        lastState = task.state;
        report(ctx, `state: ${task.state}`);
        if (task.state === "awaiting_approval") {
          report(
            ctx,
            `the task needs an owner decision; inspect it with \`coderax call GET /v1/work/${taskId}/permissions\``,
          );
        }
      }
      if (isTerminalState(task.state)) return task;
    }
    if (Date.now() >= deadline) {
      throw new CoderaxError(
        "WAIT_TIMEOUT",
        `task ${taskId} is still ${lastState} after ${timeoutMs}ms; it continues durably in the cloud. Check it with \`coderax call GET /v1/work/${taskId}\`.`,
      );
    }
    try {
      await sleep(Math.min(2000, Math.max(250, Math.floor(remaining() / 10))), ctx.signal);
    } catch (error) {
      if (error.code === "CANCELLED") {
        throw new CoderaxError(
          "CANCELLED",
          `stopped waiting for task ${taskId}; the task continues durably in the cloud`,
        );
      }
      throw error;
    }
  }
}

function artifactListFromTask(task) {
  const artifacts = Array.isArray(task?.result?.artifacts) ? task.result.artifacts : [];
  return artifacts.map((artifact) => ({
    name: basename(String(artifact.path ?? "artifact")),
    path: String(artifact.path ?? ""),
    bytes: Number.isSafeInteger(artifact.bytes) ? artifact.bytes : undefined,
    digest: typeof artifact.digest === "string" ? artifact.digest : undefined,
  }));
}

async function mergeArtifactIds(client, task, artifacts) {
  if (artifacts.length === 0) return artifacts;
  try {
    const listed = await client.listArtifacts({ taskId: task.taskId });
    const byPath = new Map(listed.map((item) => [String(item.path ?? item.name ?? ""), item]));
    return artifacts.map((artifact) => {
      const match = byPath.get(artifact.path) ?? listed.find((item) => item.name === artifact.name);
      const artifactId = match?.artifactId ?? match?.id;
      return typeof artifactId === "string" ? { ...artifact, artifactId } : artifact;
    });
  } catch {
    return artifacts;
  }
}

async function downloadArtifact(ctx, client, artifact, { out, force = false } = {}) {
  const artifactId = artifactIdOf(artifact);
  const digest = normalizeDigest(artifact.digest);
  if (digest === null) {
    throw new CoderaxError(
      "ARTIFACT_DIGEST_MISSING",
      "the artifact has no published SHA-256 digest; refusing an unverifiable download",
    );
  }
  const expectedBytes = Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 ? artifact.bytes : undefined;
  const destination = await prepareDestination({
    out,
    defaultName: artifact.name ?? basename(String(artifact.path ?? `artifact-${artifactId}`)),
    cwd: ctx.cwd,
    force,
  });
  report(
    ctx,
    `downloading ${safeText(ctx, artifact.name ?? artifactId, 120)} (${expectedBytes === undefined ? "unknown size" : formatBytes(expectedBytes)})`,
  );
  const response = await client.artifactContent(artifactId);
  const headerDigest = normalizeDigest(response.headers.get("x-artifact-sha256"));
  if (headerDigest !== null && headerDigest !== digest) {
    throw new CoderaxError(
      "ARTIFACT_INTEGRITY_FAILED",
      "the artifact download advertised a different SHA-256 than its metadata",
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  const maxBytes =
    expectedBytes !== undefined && expectedBytes >= 0
      ? Math.max(expectedBytes, 1)
      : Number.isSafeInteger(contentLength) && contentLength > 0
        ? contentLength
        : MAX_DOWNLOAD_BYTES;
  const written = await writeDownload({
    destination: destination.destination,
    force: destination.force,
    expectedSha256: digest,
    expectedBytes,
    maxBytes,
    body: response.body,
    signal: ctx.signal,
  });
  return { artifactId, path: written.path, bytes: written.bytes, sha256: written.sha256, verified: true };
}

async function outputTask(ctx, client, capability, task) {
  const artifacts = await mergeArtifactIds(client, task, artifactListFromTask(task));
  const summary = typeof task?.result?.summary === "string" ? task.result.summary : "";
  let download = null;
  if (option(ctx, "out") !== undefined) {
    if (artifacts.length !== 1) {
      throw new CoderaxError(
        "USAGE",
        `--out requires exactly one result artifact; this task produced ${artifacts.length}. Download a chosen artifact with \`coderax artifacts download <id> --out <path>\`.`,
      );
    }
    if (!artifacts[0].artifactId) {
      throw new CoderaxError(
        "ARTIFACT_ID_INVALID",
        "the task result did not publish an artifact id; list it with `coderax artifacts list --task " + task.taskId + "`",
      );
    }
    const metadata = await client.inspectArtifact(artifacts[0].artifactId);
    download = await downloadArtifact(ctx, client, metadata, {
      out: optionText(ctx, "out"),
      force: booleanFlag(option(ctx, "force"), "force"),
    });
  }
  const payload = {
    capability: { id: capability.id, command: capability.command },
    taskId: task.taskId,
    conversationId: task.conversationId ?? null,
    state: task.state,
    result: task.result ?? null,
    artifacts,
    ...(download === null ? {} : { download }),
  };
  if (ctx.json) {
    if (ctx.stream) {
      ctx.out(`${JSON.stringify(redactValue({ type: "result", ...payload }, ctx.settings.token))}\n`);
    } else {
      jsonOut(ctx, payload);
    }
    return;
  }
  if (summary) ctx.out(redact(summary, ctx.settings.token));
  if (artifacts.length > 0) {
    const rows = artifacts.map((artifact) => [
      safeText(ctx, artifact.artifactId ?? "(not listed)", 128),
      safeText(ctx, artifact.name, 180),
      artifact.bytes === undefined ? "unknown" : formatBytes(artifact.bytes),
      artifact.digest ? safeText(ctx, artifact.digest.replace(/^sha256:/i, "").slice(0, 16), 16) : "none",
    ]);
    ctx.out(table(rows, ["ARTIFACT", "NAME", "SIZE", "SHA-256"]).join("\n"));
    ctx.out("");
    ctx.out("Download with `coderax artifacts download <id> --out <path>`.");
  }
  if (download !== null) {
    ctx.out(`downloaded ${download.path} (${formatBytes(download.bytes)}, SHA-256 verified)`);
  }
  if (artifacts.length === 0 && !summary) {
    ctx.out(`task ${safeText(ctx, task.taskId, 128)} completed without a summary or artifacts.`);
  }
}

function taskFailure(task) {
  const failure = task?.failure ?? {};
  const code = typeof failure.code === "string" ? failure.code : "task_failed";
  const detail = typeof failure.detail === "string" ? `: ${failure.detail}` : "";
  return new CoderaxError(
    "CAPABILITY_TASK_FAILED",
    `task ${task.taskId} failed (${code})${detail}`,
  );
}

export async function runCapability(command, ctx) {
  const capability = capabilityForCommand(command);
  if (capability === null) {
    throw new CoderaxError("CAPABILITY_UNKNOWN", `unknown capability command: ${command}`);
  }
  const client = clientFor(ctx);
  const registry = await loadRegistry(ctx, client);
  const published = findCapability(registry, command);
  if (published === null) {
    throw new CoderaxError("CAPABILITY_UNKNOWN", `the engine does not publish a capability for ${command}`);
  }
  assertExecutable(published);

  const inputs = await collectInputs(ctx, published, client);
  if (published.command === "upload") {
    const uploaded = inputs.file;
    if (!uploaded) {
      throw new CoderaxError(
        "CAPABILITY_REGISTRY_INVALID",
        "the engine's upload capability does not declare a file input",
      );
    }
    if (ctx.json) {
      jsonOut(ctx, { capability: { id: published.id, command: published.command }, upload: uploaded });
    } else {
      ctx.out(`uploaded ${safeText(ctx, uploaded.name, 180)} (${formatBytes(uploaded.bytes)})`);
      ctx.out(`upload id: ${safeText(ctx, uploaded.uploadId, 128)}`);
      ctx.out(`sha256: ${uploaded.sha256}`);
      if (uploaded.expiresAt) ctx.out(`expires: ${safeText(ctx, uploaded.expiresAt, 40)}`);
    }
    return EXIT.OK;
  }

  return await executeAndWait({ ctx, client, capability: published, inputs });
}

async function executeAndWait({ ctx, client, capability, inputs }) {
  const { projectId, conversationId } = projectAndConversation(ctx);
  const settings = waitSettings(ctx);
  const accepted = await client.executeCapability({
    capabilityId: capability.id,
    inputs,
    projectId,
    conversationId,
    wait: settings.wait,
  });
  report(ctx, `${capability.command} accepted as task ${accepted.taskId} (${accepted.state})`);

  if (!settings.wait) {
    if (ctx.json) {
      jsonOut(ctx, {
        capability: { id: capability.id, command: capability.command },
        taskId: accepted.taskId,
        conversationId: accepted.conversationId ?? null,
        state: accepted.state,
        generation: accepted.generation,
        eventsPath: accepted.eventsPath,
      });
    } else {
      ctx.out(`task ${safeText(ctx, accepted.taskId, 128)} accepted (${accepted.state}).`);
      ctx.out(
        `It continues durably in the cloud. Check it with \`coderax call GET /v1/work/${safeText(ctx, accepted.taskId, 128)}\` or wait with \`--wait-timeout <ms>\`.`,
      );
    }
    return EXIT.OK;
  }

  const task = await waitForTask({
    client,
    accepted,
    ctx,
    timeoutMs: settings.timeoutMs,
  });
  if (task.state === "failed") throw taskFailure(task);
  if (task.state === "cancelled") {
    throw new CoderaxError("CAPABILITY_TASK_CANCELLED", `task ${task.taskId} was cancelled`);
  }
  if (task.state === "interrupted") {
    throw new CoderaxError(
      "CAPABILITY_TASK_INTERRUPTED",
      `task ${task.taskId} was interrupted; resume it with \`coderax call POST /v1/work/${task.taskId}/resume --data '{"generation":${task.generation}}'\``,
    );
  }
  await outputTask(ctx, client, capability, task);
  return EXIT.OK;
}

/** Execute a capability the catalog does not know, by registry id or command. */
export async function runCapabilityGeneric(ctx) {
  const [target, ...rest] = ctx.args ?? [];
  if (!target) {
    throw new CoderaxError("USAGE", "capability run requires a capability id or command");
  }
  const client = clientFor(ctx);
  const registry = await loadRegistry(ctx, client);
  const capability = findCapability(registry, target);
  if (capability === null) {
    const known = registry.capabilities.map((item) => item.id).join(", ");
    throw new CoderaxError(
      "CAPABILITY_UNKNOWN",
      `${target} is not published by the engine. Published capabilities: ${known || "(none)"}`,
    );
  }
  assertExecutable(capability);
  const scoped = { ...ctx, command: capability.command, args: rest };
  const inputs = await collectInputs(scoped, capability, client);
  return await executeAndWait({ ctx: scoped, client, capability, inputs });
}

function artifactRows(ctx, artifacts) {
  return artifacts.map((artifact) => [
    safeText(ctx, artifact.artifactId ?? artifact.id ?? "", 128),
    safeText(ctx, artifact.name ?? basename(String(artifact.path ?? "artifact")), 180),
    Number.isFinite(artifact.bytes) ? formatBytes(artifact.bytes) : "unknown",
    safeText(ctx, artifact.projectId ?? "", 128),
    safeText(ctx, artifact.createdAt ?? "", 40),
  ]);
}

function artifactIdOf(artifact) {
  const id = artifact.artifactId ?? artifact.id;
  if (typeof id !== "string") {
    throw new CoderaxError("ARTIFACT_ID_INVALID", "the engine returned an artifact without an id");
  }
  return assertArtifactId(id);
}

export async function artifacts(ctx) {
  const client = clientFor(ctx);
  const registry = await loadRegistry(ctx, client);
  if (registry.artifacts.status !== "available") {
    throw new CoderaxError(
      "CAPABILITY_NOT_AVAILABLE",
      `artifacts are ${registry.artifacts.status} (${registry.artifacts.reason})${registry.artifacts.detail ? `: ${registry.artifacts.detail}` : ""}`,
    );
  }
  const action = ctx.args?.[0] ?? "list";
  const rest = (ctx.args ?? []).slice(1);

  if (action === "list") {
    rejectUnknownOptions(ctx, new Set(["project", "conversation", "task", "limit"]));
    if (rest.length > 0) throw new CoderaxError("USAGE", "artifacts list takes no positional arguments");
    const projectId = optionText(ctx, "project");
    const conversationId = optionText(ctx, "conversation");
    const taskId = optionText(ctx, "task");
    const limitRaw = optionText(ctx, "limit");
    let limit;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new CoderaxError("USAGE", "--limit must be an integer between 1 and 1000");
      }
    }
    const list = await client.listArtifacts({
      projectId: projectId === undefined ? undefined : assertProjectId(projectId),
      conversationId: conversationId === undefined ? undefined : assertConversationId(conversationId),
      taskId,
      limit,
    });
    if (ctx.json) {
      jsonOut(ctx, { artifacts: list });
    } else if (list.length === 0) {
      ctx.out("no artifacts");
    } else {
      ctx.out(table(artifactRows(ctx, list), ["ARTIFACT", "NAME", "SIZE", "PROJECT", "CREATED"]).join("\n"));
    }
    return EXIT.OK;
  }

  if (action === "inspect") {
    rejectUnknownOptions(ctx, new Set());
  }
  if (action === "download") {
    rejectUnknownOptions(ctx, new Set(["out", "force"]));
  }

  if (action === "inspect") {
    const id = rest[0];
    if (!id) throw new CoderaxError("USAGE", "artifacts inspect requires an artifact id");
    if (rest.length > 1) throw new CoderaxError("USAGE", "artifacts inspect takes one artifact id");
    const artifact = await client.inspectArtifact(id);
    if (ctx.json) {
      jsonOut(ctx, artifact);
    } else {
      const entries = Object.entries(artifact).filter(([, value]) => value !== null && value !== undefined);
      ctx.out(
        table(
          entries.map(([key, value]) => [
            safeText(ctx, key, 80),
            safeText(ctx, typeof value === "object" ? JSON.stringify(value) : String(value), 1000),
          ]),
          ["FIELD", "VALUE"],
        ).join("\n"),
      );
    }
    return EXIT.OK;
  }

  if (action === "download") {
    const id = rest[0];
    if (!id) throw new CoderaxError("USAGE", "artifacts download requires an artifact id");
    if (rest.length > 1) throw new CoderaxError("USAGE", "artifacts download takes one artifact id");
    const artifact = await client.inspectArtifact(id);
    const download = await downloadArtifact(ctx, client, artifact, {
      out: optionText(ctx, "out"),
      force: booleanFlag(option(ctx, "force"), "force"),
    });
    if (ctx.json) {
      jsonOut(ctx, download);
    } else {
      ctx.out(`downloaded ${download.path} (${formatBytes(download.bytes)}, SHA-256 verified)`);
    }
    return EXIT.OK;
  }

  if (action === "associate") {
    rejectUnknownOptions(ctx, new Set(["project"]));
    const id = rest[0];
    if (!id) throw new CoderaxError("USAGE", "artifacts associate requires an artifact id");
    if (rest.length > 1) throw new CoderaxError("USAGE", "artifacts associate takes one artifact id");
    const projectId = optionText(ctx, "project");
    if (projectId === undefined) {
      throw new CoderaxError("USAGE", "artifacts associate requires --project <id>");
    }
    const artifact = await client.associateArtifact(id, projectId);
    if (ctx.json) {
      jsonOut(ctx, artifact);
    } else {
      ctx.out(`artifact ${id} associated with project ${assertProjectId(projectId)}`);
    }
    return EXIT.OK;
  }

  throw new CoderaxError("USAGE", `unknown artifacts action: ${action}`);
}
