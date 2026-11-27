/**
 * At-most-once Work submission for the `/v1` contract.
 *
 * `POST /v1/work` is not idempotent on the engine side, so a lost response is
 * genuinely ambiguous: the task may or may not exist. This module never retries
 * that ambiguity. It records the idempotency key before transmitting, then one
 * of three things happens:
 *
 * - the engine accepts the task and the key is bound to `taskId`;
 * - the engine definitely rejects it (a 4xx other than timeout/rate-limit, or a
 *   failure before the request was transmitted) and the key is marked failed;
 * - the outcome is unknown, and the key is marked `uncertain`.
 *
 * An `uncertain` key refuses a second submission until the owner either binds it
 * to the task that actually exists (`resolveSubmission`) or explicitly chooses to
 * submit again. That is the only thing standing between a network blip and
 * duplicate cloud execution.
 *
 * The ledger is injected so the SDK stays storage-agnostic: the terminal passes a
 * durable file-backed ledger, tests pass an in-memory one.
 */

import { createHash, randomUUID } from "node:crypto";
import { SdkError } from "../errors.js";
import { DATA_MODES } from "./contract.js";

const STALE_SUBMITTING_MS = 300_000;

export function objectiveHash(objective) {
  return createHash("sha256").update(String(objective)).digest("hex").slice(0, 16);
}

export function newSubmissionKey() {
  return randomUUID();
}

/** `provider/model` (a slash in the model id is preserved). */
export function parseModelRef(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && typeof value.providerId === "string" && typeof value.modelId === "string") {
    return { providerId: value.providerId, modelId: value.modelId };
  }
  const text = String(value);
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new SdkError("USAGE", "a model must be written as provider/model", {
      details: { value: text },
    });
  }
  return { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

/**
 * Build a `WorkSubmitRequest`. The mode defaults to `cloud` because Work is
 * cloud execution by definition; `private` is an explicit owner choice.
 */
export function buildWorkRequest({
  objective,
  conversationId,
  agent,
  model,
  mode = "cloud",
  budget,
  requireApproval = true,
}) {
  if (typeof objective !== "string" || objective.trim() === "") {
    throw new SdkError("USAGE", "a Work task needs a non-empty objective");
  }
  if (!DATA_MODES.includes(mode)) {
    throw new SdkError("USAGE", `mode must be one of ${DATA_MODES.join(", ")}`);
  }
  const body = { objective, mode, requireApproval };
  if (conversationId) body.conversationId = conversationId;
  if (agent) body.agent = agent;
  if (model) body.model = parseModelRef(model);
  if (budget) body.budget = budget;
  return body;
}

/** A 4xx other than timeout/rate-limit is a definite rejection, not ambiguity. */
function definitelyRejected(error) {
  if (error?.code === "CANCELLED") return true;
  if (error?.code === "USAGE" || error?.code === "CONTRACT_VIOLATION") return true;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    return error.status !== 408 && error.status !== 429;
  }
  return false;
}

/** The request provably never reached the engine. */
function neverTransmitted(error) {
  return error?.transmitted === false;
}

function uncertainError(key, request, cause) {
  return new SdkError(
    "SUBMISSION_UNCERTAIN",
    `the engine did not confirm submission ${key}; the task may or may not exist`,
    {
      retryable: false,
      details: {
        submissionKey: key,
        conversationId: request.conversationId ?? null,
        cause: cause?.code ?? "UNKNOWN",
      },
    },
  );
}

/**
 * Submit one durable task for one key, at most once.
 *
 * @param {object} options
 * @param {import("./client.js").V1Client} options.client
 * @param {{submission: Function, upsertSubmission: Function, task?: Function, upsertTask?: Function}} options.ledger
 * @param {object} options.request
 * @param {string} [options.idempotencyKey]
 * @param {boolean} [options.retryUncertain] the owner explicitly chose to submit again
 * @param {AbortSignal} [options.signal]
 * @param {() => string} [options.now]
 */
export async function submitWork({
  client,
  ledger,
  request,
  idempotencyKey = newSubmissionKey(),
  retryUncertain = false,
  signal,
  now = () => new Date().toISOString(),
} = {}) {
  const key = String(idempotencyKey);
  const existing = await ledger.submission(key);

  if (existing?.taskId && existing.status === "accepted") {
    const task = typeof ledger.task === "function" ? await ledger.task(existing.taskId) : null;
    return {
      accepted: null,
      task: task ?? {
        taskId: existing.taskId,
        conversationId: existing.conversationId ?? request.conversationId ?? null,
        objective: request.objective,
        state: existing.state ?? "queued",
        submissionId: key,
      },
      submissionKey: key,
      reused: true,
    };
  }

  if (existing?.status === "uncertain" && retryUncertain !== true) {
    throw new SdkError(
      "SUBMISSION_UNCERTAIN",
      `submission ${key} may already have been accepted; refusing to create a duplicate`,
      {
        retryable: false,
        details: {
          submissionKey: key,
          conversationId: existing.conversationId ?? request.conversationId ?? null,
          createdAt: existing.createdAt ?? null,
        },
      },
    );
  }

  const startedAt = Date.parse(existing?.createdAt ?? "");
  if (
    existing?.status === "submitting" &&
    Number.isFinite(startedAt) &&
    Date.now() - startedAt < STALE_SUBMITTING_MS
  ) {
    throw new SdkError(
      "SUBMISSION_IN_PROGRESS",
      `submission ${key} is already being sent by another Coderax process`,
      { retryable: false, details: { submissionKey: key } },
    );
  }

  await ledger.upsertSubmission(key, {
    status: "submitting",
    objectiveHash: objectiveHash(request.objective),
    objective: String(request.objective).slice(0, 500),
    conversationId: request.conversationId ?? null,
    agent: request.agent ?? null,
    mode: request.mode ?? "cloud",
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  });

  let accepted;
  try {
    accepted = await client.submitWork(request, { signal, idempotencyKey: key });
  } catch (error) {
    if (definitelyRejected(error) || neverTransmitted(error)) {
      await ledger.upsertSubmission(key, {
        status: "failed",
        updatedAt: now(),
        errorCode: error?.code ?? "UNKNOWN",
      });
      throw error;
    }
    await ledger.upsertSubmission(key, {
      status: "uncertain",
      updatedAt: now(),
      errorCode: error?.code ?? "UNKNOWN",
    });
    if (error?.code === "SUBMISSION_UNCERTAIN") throw error;
    throw uncertainError(key, request, error);
  }

  const record = {
    taskId: accepted.taskId,
    conversationId: accepted.conversationId,
    objective: request.objective,
    agent: request.agent ?? "coderax",
    mode: request.mode ?? "cloud",
    model: request.model ?? null,
    state: accepted.state,
    generation: accepted.generation,
    submissionId: key,
    createdAt: now(),
    updatedAt: now(),
  };
  if (typeof ledger.upsertTask === "function") await ledger.upsertTask(record);
  await ledger.upsertSubmission(key, {
    status: "accepted",
    taskId: accepted.taskId,
    conversationId: accepted.conversationId,
    updatedAt: now(),
  });
  return { accepted, task: record, submissionKey: key, reused: false };
}

/**
 * Bind an ambiguous key to the task that actually exists, after the owner found
 * it in Web or in the notification list.
 */
export async function resolveSubmission({ client, ledger, key, taskId, signal, now = () => new Date().toISOString() }) {
  const status = await client.task(taskId, { signal });
  const existing = await ledger.submission(key);
  if (typeof ledger.upsertTask === "function") {
    await ledger.upsertTask({
      taskId: status.taskId,
      conversationId: status.conversationId,
      objective: existing?.objective ?? "(resolved submission)",
      agent: status.agent,
      mode: status.mode,
      model: status.model ?? null,
      state: status.state,
      generation: status.generation,
      submissionId: key,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
    });
  }
  await ledger.upsertSubmission(key, {
    status: "accepted",
    taskId: status.taskId,
    conversationId: status.conversationId,
    updatedAt: now(),
    resolvedManually: true,
  });
  return { status, submission: await ledger.submission(key) };
}

/**
 * In-memory ledger. Used by tests and by `--no-state` runs; it never survives the
 * process, so it must not be the default for a real submission.
 */
export function createMemoryLedger(seed = {}) {
  const submissions = new Map(Object.entries(seed.submissions ?? {}));
  const tasks = new Map(Object.entries(seed.tasks ?? {}));
  return {
    async submission(key) {
      return submissions.get(key) ?? null;
    },
    async upsertSubmission(key, patch) {
      submissions.set(key, { ...(submissions.get(key) ?? {}), ...patch, submissionKey: key });
    },
    async task(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async upsertTask(record) {
      tasks.set(record.taskId, { ...(tasks.get(record.taskId) ?? {}), ...record });
    },
    snapshot() {
      return {
        submissions: Object.fromEntries(submissions),
        tasks: Object.fromEntries(tasks),
      };
    },
  };
}
