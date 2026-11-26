import { createHash, randomUUID } from "node:crypto";
import { CoderaxError, CancelledError } from "../errors.js";
import { taskRecord } from "../state.js";

export function objectiveHash(objective) {
  return createHash("sha256").update(String(objective)).digest("hex").slice(0, 16);
}

export function newSubmissionKey() {
  return randomUUID();
}

export function parseModelRef(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && typeof value.providerId === "string" && typeof value.modelId === "string") {
    return { providerId: value.providerId, modelId: value.modelId };
  }
  const text = String(value);
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new CoderaxError("USAGE", "a model must be written as provider/model", {
      hint: "Run `coderax models` to list available model references.",
    });
  }
  return { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

export function buildWorkRequest({
  objective,
  conversationId,
  agent,
  model,
  mode = "cloud",
  budget,
  requireApproval = true,
}) {
  const body = { objective, mode, requireApproval };
  if (conversationId) body.conversationId = conversationId;
  if (agent) body.agent = agent;
  if (model) body.model = parseModelRef(model);
  if (budget) body.budget = budget;
  return body;
}

function isPreTransmit(error) {
  return error?.code === "REQUEST_FAILED" && error?.transmitted === false;
}

/** A 4xx (except timeout/rate-limit) is a definite rejection, not an ambiguity. */
function definitelyRejected(error) {
  if (error?.code === "CANCELLED" || error instanceof CancelledError) return true;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    return error.status !== 408 && error.status !== 429;
  }
  return false;
}

/**
 * Submit at most one durable task for one idempotency key.
 *
 * The engine's submit operation is not idempotent, so a lost response is
 * genuinely ambiguous. The CLI never retries that ambiguity automatically: it
 * records the key, refuses a silent duplicate, and exposes the key and any
 * conversation id so the owner can reconcile with `coderax work resolve`.
 */
export async function submitWork({
  client,
  state,
  request,
  idempotencyKey = newSubmissionKey(),
  retryUncertain = false,
  signal,
  now = () => new Date().toISOString(),
  onAccepted = () => {},
} = {}) {
  const key = String(idempotencyKey);
  const existing = state ? await state.submission(key) : null;

  if (existing?.taskId) {
    const task = await state.task(existing.taskId);
    return {
      accepted: null,
      task: task ?? {
        taskId: existing.taskId,
        conversationId: request.conversationId ?? existing.conversationId ?? null,
        objective: request.objective,
        state: existing.state ?? "queued",
      },
      submissionKey: key,
      reused: true,
    };
  }

  if (existing?.status === "uncertain" && !retryUncertain) {
    throw new CoderaxError(
      "SUBMISSION_UNCERTAIN",
      `submission ${key} may already have been accepted; refusing to create a duplicate`,
      {
        details: {
          submissionKey: key,
          conversationId: existing.conversationId ?? request.conversationId ?? null,
          createdAt: existing.createdAt,
        },
        hint: `Check the conversation in Coderax Web, then run \`coderax work resolve ${key} <taskId>\` or pass --retry-submission to submit again.`,
      },
    );
  }

  if (existing?.status === "submitting" && Date.now() - Date.parse(existing.createdAt ?? 0) < 300_000) {
    throw new CoderaxError(
      "SUBMISSION_IN_PROGRESS",
      `submission ${key} is already being sent by another Coderax process`,
      { hint: "Wait for that process to finish, or use a new submission key." },
    );
  }

  if (state) {
    await state.upsertSubmission(key, {
      status: "submitting",
      objectiveHash: objectiveHash(request.objective),
      objective: request.objective.slice(0, 500),
      conversationId: request.conversationId ?? null,
      agent: request.agent ?? null,
      mode: request.mode ?? "cloud",
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    });
  }

  let accepted;
  try {
    accepted = await client.submitWork(request, { signal, idempotencyKey: key });
  } catch (error) {
    if (definitelyRejected(error)) {
      if (state) {
        await state.upsertSubmission(key, {
          status: "failed",
          updatedAt: now(),
          errorCode: error?.code ?? "UNKNOWN",
        });
      }
      throw error;
    }
    if (isPreTransmit(error) && state) {
      await state.upsertSubmission(key, {
        status: "failed",
        updatedAt: now(),
        errorCode: error.code,
      });
      throw error;
    }
    if (state) {
      await state.upsertSubmission(key, {
        status: "uncertain",
        updatedAt: now(),
        errorCode: error?.code ?? "UNKNOWN",
      });
    }
    if (error?.code === "SUBMISSION_UNCERTAIN") throw error;
    throw new CoderaxError(
      "SUBMISSION_UNCERTAIN",
      `the engine did not confirm submission ${key}; the task may or may not exist`,
      {
        retryable: false,
        details: {
          submissionKey: key,
          conversationId: request.conversationId ?? null,
          cause: error?.code ?? "UNKNOWN",
        },
        hint: `Check Coderax Web for the conversation, then bind it with \`coderax work resolve ${key} <taskId>\`; do not blindly resubmit.`,
      },
    );
  }

  const record = taskRecord({
    accepted,
    conversationId: request.conversationId,
    objective: request.objective,
    agent: request.agent ?? accepted.agent ?? "coderax",
    mode: request.mode ?? "cloud",
    model: request.model ?? null,
    submissionId: key,
    now: now(),
  });
  if (state) {
    await state.upsertTask(record);
    await state.upsertSubmission(key, {
      status: "accepted",
      taskId: accepted.taskId,
      conversationId: accepted.conversationId,
      updatedAt: now(),
    });
  }
  await onAccepted({ accepted, task: record, submissionKey: key });
  return { accepted, task: record, submissionKey: key, reused: false };
}

/** Bind an ambiguous submission key to the task that actually exists. */
export async function resolveSubmission({ client, state, key, taskId, signal }) {
  const status = await client.task(taskId, { signal });
  const existing = await state.submission(key);
  await state.upsertTask(taskRecord({
    accepted: {
      taskId: status.taskId,
      conversationId: status.conversationId,
      state: status.state,
      generation: status.generation,
    },
    conversationId: status.conversationId,
    objective: existing?.objective ?? "(resolved submission)",
    agent: status.agent,
    mode: status.mode,
    model: status.model ?? null,
    submissionId: key,
  }));
  await state.upsertSubmission(key, {
    status: "accepted",
    taskId: status.taskId,
    conversationId: status.conversationId,
    updatedAt: new Date().toISOString(),
    resolvedManually: true,
  });
  return { status, submission: await state.submission(key) };
}
