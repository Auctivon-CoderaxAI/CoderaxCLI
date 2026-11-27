import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CoderaxError } from "./client.js";
import { configDir } from "./config.js";
import { TASK_STATES, isTerminalTaskState, taskPath } from "./engine-contract.js";
import { EventAssembler, validateExecutionEvent } from "./engine-events.js";

/**
 * Durable task synchronisation on top of the authoritative engine contract.
 *
 * The local file is advisory bookkeeping only: applied cursors, dedupe ids,
 * submission intents, task summaries and acknowledgement receipts. It never
 * becomes a source of task truth (the engine's `GET /v1/work/{taskId}` is), and
 * it never stores prompts, transcripts, tool output, artifact content or
 * credentials. State is partitioned by deployment origin, a non-reversible
 * fingerprint of the authenticated owner token, and the environment name, so a
 * cursor applied against one deployment or owner cannot suppress an event on
 * another.
 *
 * Ordering rules:
 *   1. A snapshot/event is rendered first and committed second. A handler that
 *      throws leaves the persisted cursor unchanged, so the event is
 *      re-delivered rather than skipped.
 *   2. `eventId` and per-task `seq` are the only dedupe keys. A gap is reported
 *      and reconciled against the authoritative task snapshot.
 *   3. `stream.truncated` means replay lost history: reconcile the snapshot,
 *      then continue from the oldest retained sequence.
 *   4. An ambiguous submission is never retried automatically. The server's
 *      `idempotencyKey` makes an explicit `--resume-key` retry return the
 *      original task instead of starting a second run.
 */

const ENGINE_STATE_VERSION = 2;
const MAX_APPLIED_EVENTS = 256;
const MAX_TASKS = 100;
const MAX_SUBMISSIONS = 20;
const MAX_RECEIPTS = 100;
const MAX_NOTIFICATIONS = 200;
const MAX_PERMISSIONS = 50;

const AMBIGUOUS_CODES = new Set([
  "NETWORK",
  "REQUEST_FAILED",
  "TIMEOUT",
  "REQUEST_TIMEOUT",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "STREAM_INCOMPLETE",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopback(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Advisory state identity. `owner` is a truncated SHA-256 of the bearer token:
 * it distinguishes two authenticated principals without writing the credential
 * (or a reversible form of it) to disk. `environment` separates deployments
 * that share an origin, for example a local proxy and production.
 */
export function enginePartition({ baseUrl, token, environment, env = process.env } = {}) {
  if (typeof baseUrl !== "string" || baseUrl === "") {
    throw new CoderaxError("BASE_URL_REQUIRED", "no engine deployment URL configured");
  }
  const origin = new URL(baseUrl).origin;
  const name =
    (typeof environment === "string" && environment.trim() !== ""
      ? environment.trim()
      : env.CODERAX_ENVIRONMENT?.trim()) ||
    (isLoopback(origin) ? "local" : "production");
  const owner = createHash("sha256")
    .update(typeof token === "string" && token !== "" ? token : "anonymous")
    .digest("hex")
    .slice(0, 16);
  return Object.freeze({ origin, owner, environment: name });
}

export function partitionKey(partition) {
  return createHash("sha256")
    .update(`${partition.origin}\n${partition.owner}\n${partition.environment}`)
    .digest("hex")
    .slice(0, 16);
}

export function engineStatePath(env = process.env, partition) {
  const override = env.CODERAX_ENGINE_STATE?.trim();
  if (override && override !== "") return override;
  const directory = env.CODERAX_CONFIG?.trim()
    ? dirname(env.CODERAX_CONFIG.trim())
    : configDir(env);
  return join(directory, `engine-${partitionKey(partition)}.json`);
}

function emptyState(partition) {
  return {
    version: ENGINE_STATE_VERSION,
    partition: { ...partition },
    cursor: {},
    applied: {},
    tasks: {},
    submissions: {},
    receipts: {},
    permissions: {},
    notifications: {},
  };
}

function boundedPut(map, key, value, limit) {
  map[key] = value;
  const keys = Object.keys(map);
  while (keys.length > limit) {
    delete map[keys.shift()];
  }
}

function normalizeState(document, partition) {
  if (!isRecord(document) || document.version !== ENGINE_STATE_VERSION) {
    return emptyState(partition);
  }
  if (
    !isRecord(document.partition) ||
    document.partition.origin !== partition.origin ||
    document.partition.owner !== partition.owner ||
    document.partition.environment !== partition.environment
  ) {
    throw new CoderaxError(
      "STATE_PARTITION_MISMATCH",
      "the task state file belongs to another deployment, owner or environment; refusing to reuse it",
      { details: { expected: { ...partition } } },
    );
  }
  return {
    ...emptyState(partition),
    ...document,
    cursor: isRecord(document.cursor) ? document.cursor : {},
    applied: isRecord(document.applied) ? document.applied : {},
    tasks: isRecord(document.tasks) ? document.tasks : {},
    submissions: isRecord(document.submissions) ? document.submissions : {},
    receipts: isRecord(document.receipts) ? document.receipts : {},
    permissions: isRecord(document.permissions) ? document.permissions : {},
    notifications: isRecord(document.notifications) ? document.notifications : {},
  };
}

export function createEngineStateStore(path) {
  return {
    path,
    async load() {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          throw new CoderaxError("STATE_INSECURE", `${path} is a symbolic link; refusing to read task state through it`);
        }
        const text = await readFile(path, "utf8");
        const parsed = JSON.parse(text);
        return isRecord(parsed) ? parsed : null;
      } catch (error) {
        if (error instanceof CoderaxError) throw error;
        return null;
      }
    },
    async persist(snapshot) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          throw new CoderaxError("STATE_INSECURE", `${path} is a symbolic link; refusing to write task state through it`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
      try {
        await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        try {
          await chmod(tempPath, 0o600);
        } catch (error) {
          if (process.platform !== "win32") throw error;
        }
        await rename(tempPath, path);
      } catch (error) {
        try {
          await unlink(tempPath);
        } catch {
          // Nothing to clean up.
        }
        throw error;
      }
    },
  };
}

export class EngineTaskSynchronizer {
  constructor({ client, store, partition, now = () => new Date().toISOString(), onDiagnostic, sleep } = {}) {
    if (!client) throw new TypeError("EngineTaskSynchronizer requires an engine client");
    if (!store) throw new TypeError("EngineTaskSynchronizer requires a state store");
    if (!partition) throw new TypeError("EngineTaskSynchronizer requires a partition");
    this.client = client;
    this.store = store;
    this.partition = partition;
    this.now = now;
    this.onDiagnostic = onDiagnostic;
    this.sleep =
      sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
    this.state = emptyState(partition);
    this.diagnostics = [];
    this.loaded = false;
  }

  async load() {
    const document = await this.store.load();
    this.state = normalizeState(document, this.partition);
    this.loaded = true;
    return this;
  }

  report(code, message, details = null) {
    const entry = { code, message, details, at: this.now() };
    this.diagnostics.push(entry);
    this.onDiagnostic?.(entry);
    return entry;
  }

  async persist() {
    try {
      await this.store.persist(this.state);
      return true;
    } catch (error) {
      if (error instanceof CoderaxError && error.code === "STATE_PARTITION_MISMATCH") throw error;
      this.report("STATE_PERSIST_FAILED", `could not persist task state: ${error.message}`);
      return false;
    }
  }

  cursorFor(taskId) {
    const value = this.state.cursor[taskId];
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  taskFor(taskId) {
    return this.state.tasks[taskId] ?? null;
  }

  refreshTaskSummary(task) {
    if (!isRecord(task) || typeof task.taskId !== "string") return null;
    const summary = {
      state: typeof task.state === "string" ? task.state : null,
      generation: Number.isInteger(task.generation) ? task.generation : null,
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : null,
      cancelRequested: task.cancelRequested === true,
    };
    boundedPut(this.state.tasks, task.taskId, summary, MAX_TASKS);
    return summary;
  }

  async reconcile(taskId) {
    const task = await this.client.task(taskId);
    this.refreshTaskSummary(task);
    if (isTerminalTaskState(task.state)) {
      this.recordReceipt(task);
    }
    await this.persist();
    return task;
  }

  recordReceipt(task) {
    if (!isRecord(task) || !isTerminalTaskState(task.state)) return null;
    const key = `${task.taskId}|${task.state}|${task.generation ?? 0}|${task.updatedAt ?? ""}`;
    boundedPut(
      this.state.receipts,
      task.taskId,
      {
        state: task.state,
        generation: Number.isInteger(task.generation) ? task.generation : null,
        updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : null,
        key,
        confirmedAt: this.now(),
      },
      MAX_RECEIPTS,
    );
    return key;
  }

  /**
   * Submit durable Work exactly once.
   *
   * A generated `idempotencyKey` is recorded before the POST. When the response
   * is ambiguous the submission is marked `unknown` and the error instructs the
   * caller to reconcile explicitly with `--resume-key`; nothing is re-posted
   * automatically. `--resume-key` requires the same objective (verified by
   * digest) and reuses the server-side reservation, so it cannot start a second
   * task.
   */
  async submit({
    objective,
    idempotencyKey,
    resumeKey,
    agent,
    mode,
    model,
    requireApproval,
    budget,
  } = {}) {
    if (typeof objective !== "string" || objective.trim() === "") {
      throw new CoderaxError("USAGE", "a non-empty Work objective is required");
    }
    const key = resumeKey ?? idempotencyKey ?? `cli-${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(key)) {
      throw new CoderaxError(
        "USAGE",
        "idempotency key must be 8-120 url-safe characters, starting with a letter or digit",
      );
    }
    const objectiveSha256 = createHash("sha256").update(objective).digest("hex");
    const existing = this.state.submissions[key] ?? null;

    if (resumeKey === undefined && existing === null) {
      // A previous attempt for this exact objective may be unresolved. A new
      // submission would be a duplicate side effect, so refuse and name the key
      // that can be reconciled explicitly.
      const unresolved = Object.entries(this.state.submissions).find(
        ([, entry]) =>
          entry?.objectiveSha256 === objectiveSha256 &&
          (entry.state === "unknown" || entry.state === "pending"),
      );
      if (unresolved !== undefined) {
        throw new CoderaxError(
          "SUBMISSION_UNKNOWN",
          `an earlier submission of this objective is unresolved (${unresolved[0]}). ` +
            `It was not retried. Reconcile with --resume-key ${unresolved[0]}.`,
          { details: { submissionKey: unresolved[0], state: unresolved[1].state } },
        );
      }
    }

    if (resumeKey !== undefined) {
      if (existing === null) {
        throw new CoderaxError("SUBMISSION_UNKNOWN", `no recorded submission ${key}`, {
          details: { submissionKey: key },
        });
      }
      if (existing.objectiveSha256 !== objectiveSha256) {
        throw new CoderaxError(
          "SUBMISSION_MISMATCH",
          `submission ${key} was recorded for a different objective; the same key cannot be reused`,
          { details: { submissionKey: key } },
        );
      }
    } else if (existing !== null) {
      if (existing.state === "accepted" && typeof existing.taskId === "string") {
        return {
          accepted: {
            taskId: existing.taskId,
            state: existing.state === "accepted" ? this.state.tasks[existing.taskId]?.state ?? "queued" : "queued",
            generation: existing.generation ?? this.state.tasks[existing.taskId]?.generation ?? 0,
            eventsPath: taskPath(existing.taskId, "/events"),
            replayed: true,
          },
          submissionKey: key,
          replayed: true,
          local: true,
        };
      }
      throw new CoderaxError(
        "SUBMISSION_UNKNOWN",
        `submission ${key} is ${existing.state}; an ambiguous submission is never retried automatically. ` +
          `Re-run with the same objective and --resume-key ${key} to reconcile it.`,
        { details: { submissionKey: key, state: existing.state } },
      );
    }

    boundedPut(
      this.state.submissions,
      key,
      {
        state: "pending",
        taskId: existing?.taskId ?? null,
        generation: existing?.generation ?? null,
        objectiveSha256,
        at: this.now(),
      },
      MAX_SUBMISSIONS,
    );
    await this.persist();

    const body = {
      objective,
      idempotencyKey: key,
      requireApproval: requireApproval !== false,
      mode: mode ?? "cloud",
    };
    if (agent !== undefined) body.agent = agent;
    if (model !== undefined) body.model = model;
    if (budget !== undefined) body.budget = budget;

    let accepted;
    try {
      accepted = await this.client.submitWork(body);
    } catch (error) {
      const ambiguous =
        (error instanceof CoderaxError &&
          (error.retryable === true || AMBIGUOUS_CODES.has(error.code))) ||
        (typeof error?.status === "number" && error.status >= 500);
      if (ambiguous) {
        boundedPut(
          this.state.submissions,
          key,
          {
            state: "unknown",
            taskId: existing?.taskId ?? null,
            generation: existing?.generation ?? null,
            objectiveSha256,
            at: this.now(),
            code: error.code ?? null,
          },
          MAX_SUBMISSIONS,
        );
        await this.persist();
        throw new CoderaxError(
          "SUBMISSION_UNKNOWN",
          `the Work submission may or may not have been accepted (${error.code ?? "transport failure"}). ` +
            `It was not retried. Reconcile with the same objective and --resume-key ${key}.`,
          { details: { submissionKey: key, cause: error.code ?? null }, retryable: false },
        );
      }
      boundedPut(
        this.state.submissions,
        key,
        {
          state: "failed",
          taskId: existing?.taskId ?? null,
          objectiveSha256,
          at: this.now(),
          code: error.code ?? null,
        },
        MAX_SUBMISSIONS,
      );
      await this.persist();
      throw error;
    }

    this.refreshTaskSummary(accepted);
    boundedPut(
      this.state.submissions,
      key,
      {
        state: "accepted",
        taskId: accepted.taskId,
        generation: accepted.generation,
        objectiveSha256,
        at: this.now(),
        replayed: accepted.replayed === true,
      },
      MAX_SUBMISSIONS,
    );
    await this.persist();
    return {
      accepted,
      submissionKey: key,
      replayed: accepted.replayed === true,
      local: false,
    };
  }

  /**
   * Follow a task from its persisted cursor to a terminal event.
   *
   * The engine owns the run: detaching only closes this stream. A dropped
   * connection reconnects with `after=<last applied seq>`; the in-memory
   * assembler suppresses duplicate text, and applied ids are remembered so a
   * replay cannot be applied twice.
   */
  async follow(taskId, { onEvent, signal, maxReconnects = 8 } = {}) {
    let cursor = this.cursorFor(taskId);
    let truncated = false;
    const assembler = new EventAssembler();
    let failures = 0;
    let lastError = null;

    const remember = (eventId) => {
      const applied = Array.isArray(this.state.applied[taskId]) ? this.state.applied[taskId] : [];
      if (!applied.includes(eventId)) applied.push(eventId);
      while (applied.length > MAX_APPLIED_EVENTS) applied.shift();
      this.state.applied[taskId] = applied;
    };
    const isApplied = (eventId) =>
      Array.isArray(this.state.applied[taskId]) && this.state.applied[taskId].includes(eventId);

    for (;;) {
      if (signal?.aborted) {
        return { task: this.taskFor(taskId), terminal: null, cursor, truncated, detached: true, events: assembler.eventCount };
      }
      try {
        for await (const event of this.client.events(taskId, {
          after: cursor > 0 ? cursor : undefined,
          signal,
        })) {
          failures = 0;
          if (event.type === "stream.truncated") {
            validateExecutionEvent(event, { taskId });
            const payload = event.payload;
            truncated = true;
            await this.reconcile(taskId);
            const oldest = payload.oldestSeq;
            if (oldest - 1 > cursor) {
              cursor = oldest - 1;
              this.state.cursor[taskId] = cursor;
              await this.persist();
            }
            this.report(
              "STREAM_TRUNCATED",
              `replay for ${taskId} began at seq ${oldest}; the earlier window is gone and the task snapshot was reconciled`,
              { after: payload.after, oldestSeq: oldest },
            );
            continue;
          }

          validateExecutionEvent(event, { taskId });
          if (isApplied(event.eventId) || event.seq <= cursor) {
            continue;
          }
          if (event.seq > cursor + 1) {
            // A missing sequence is never guessed across. Reconcile the
            // authoritative snapshot first, then treat this event as the new
            // frontier.
            await this.reconcile(taskId);
            this.report(
              "REPLAY_GAP",
              `event seq ${event.seq} arrived after ${cursor} for ${taskId}; the task snapshot was reconciled before continuing`,
              { taskId, expected: cursor + 1, received: event.seq },
            );
            cursor = event.seq - 1;
          }

          const outcome = assembler.apply(event);
          // Render first, commit second. A handler failure leaves the cursor
          // unchanged so the event is re-delivered on the next attempt.
          await onEvent?.(event, outcome);
          cursor = event.seq;
          this.state.cursor[taskId] = cursor;
          remember(event.eventId);
          const task = this.refreshTaskSummary({
            taskId,
            state:
              outcome.kind === "terminal"
                ? outcome.terminal.state
                : this.state.tasks[taskId]?.state ?? "running",
            generation: event.generation,
            updatedAt: event.at,
          });
          await this.persist();

          if (outcome.kind === "terminal") {
            let task_ = task;
            let confirmed = false;
            try {
              const snapshot = await this.client.task(taskId);
              this.refreshTaskSummary(snapshot);
              if (isTerminalTaskState(snapshot.state)) this.recordReceipt(snapshot);
              await this.persist();
              task_ = this.state.tasks[taskId];
              confirmed = true;
            } catch (error) {
              if (!(error instanceof CoderaxError) || error.retryable !== true) throw error;
              this.report(
                "RECEIPT_UNCONFIRMED",
                `terminal event received for ${taskId}, but the completion receipt could not be confirmed: ${error.message}`,
              );
            }
            return {
              task: task_,
              terminal: outcome.terminal,
              cursor,
              truncated,
              detached: false,
              confirmed,
              events: assembler.eventCount,
            };
          }
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof CoderaxError && error.code === "CANCELLED")) {
          return { task: this.taskFor(taskId), terminal: null, cursor, truncated, detached: true, events: assembler.eventCount };
        }
        if (!(error instanceof CoderaxError) || (error.retryable !== true && !AMBIGUOUS_CODES.has(error.code))) {
          throw error;
        }
        lastError = error;
      }

      failures += 1;
      if (failures > maxReconnects) {
        throw new CoderaxError(
          "STREAM_INCOMPLETE",
          `lost the event stream for ${taskId} after ${maxReconnects} reconnect attempts${lastError ? `: ${lastError.message}` : ""}; the task may still be running`,
          { details: { taskId, cursor }, retryable: false },
        );
      }
      await this.sleep(Math.min(5000, 250 * 2 ** (failures - 1)));
    }
  }

  async cancel(taskId, reason) {
    const result = await this.client.cancel(taskId, reason);
    if (result.outcome === "superseded" || result.outcome === "not_found") {
      await this.reconcile(taskId);
    } else {
      this.refreshTaskSummary(result);
      await this.persist();
    }
    return result;
  }

  #generationFor(taskId, generation) {
    if (Number.isInteger(generation) && generation >= 0) return generation;
    const local = this.state.tasks[taskId]?.generation;
    if (Number.isInteger(local)) return local;
    throw new CoderaxError(
      "GENERATION_REQUIRED",
      `the generation for ${taskId} is unknown; pass --generation <n> from \`coderax engine task ${taskId}\``,
    );
  }

  async resume(taskId, { generation } = {}) {
    const result = await this.client.resume(taskId, this.#generationFor(taskId, generation));
    if (result.outcome === "superseded" || result.outcome === "not_found") {
      await this.reconcile(taskId);
    } else {
      this.refreshTaskSummary(result);
      await this.persist();
    }
    return result;
  }

  async retry(taskId, { generation, model } = {}) {
    const result = await this.client.retry(taskId, this.#generationFor(taskId, generation), model);
    if (result.outcome === "superseded" || result.outcome === "not_found") {
      await this.reconcile(taskId);
    } else {
      this.refreshTaskSummary(result);
      await this.persist();
    }
    return result;
  }

  async decidePermission(taskId, { requestId, decision, reason } = {}) {
    if (decision !== "approved" && decision !== "denied") {
      throw new CoderaxError("USAGE", "decision must be approved or denied");
    }
    const result = await this.client.decidePermission(taskId, {
      requestId,
      decision,
      ...(reason ? { reason } : {}),
    });
    const decisions = isRecord(this.state.permissions[taskId]) ? this.state.permissions[taskId] : {};
    boundedPut(decisions, requestId, { decision, at: this.now() }, MAX_PERMISSIONS);
    this.state.permissions[taskId] = decisions;
    await this.persist();
    return result;
  }

  async acknowledge(taskId) {
    const result = await this.client.markNotificationRead(taskId);
    boundedPut(
      this.state.notifications,
      taskId,
      { state: this.state.tasks[taskId]?.state ?? null, ackedAt: this.now() },
      MAX_NOTIFICATIONS,
    );
    await this.persist();
    return result;
  }

  async notifications() {
    return this.client.notifications();
  }
}

export { ENGINE_STATE_VERSION, TASK_STATES };
