import { randomUUID } from "node:crypto";
import { CAPABILITY, isTerminalStatus } from "./contract.js";
import { SdkError } from "./errors.js";
import { approvalFor, runFingerprint, terminalOutcome } from "./task-events.js";

/**
 * Task synchronisation over the authoritative WorkflowEngine contract.
 *
 * What this layer adds to `WorkflowClient` is state discipline, not a second
 * protocol:
 *
 * - a snapshot is rendered, then committed; a failed render re-delivers it;
 * - a cursor is persisted only when the deployment issued one, and only after
 *   the snapshot was handled;
 * - an ambiguous build submission is never retried, with the same key or a new
 *   one, because `/api/workflows/builds` creates a run per accepted POST;
 * - approval and cancellation reconcile a 409 by re-reading authoritative
 *   state instead of guessing;
 * - completion is confirmed with `GET /api/workflows/runs/:id` before any
 *   notification is emitted.
 */

const AMBIGUOUS_SUBMISSION_CODES = new Set([
  "NETWORK",
  "TIMEOUT",
  "UNAVAILABLE",
  "RATE_LIMITED",
]);

const DEFAULT_OUTCOME = Object.freeze({ terminal: false, kind: "pending", status: null, error: null });

function newSubmissionKey() {
  // Local correlation identity. It is intentionally not sent to the backend:
  // the published build route has no idempotency field, and inventing one
  // would suggest a guarantee the deployment does not make.
  return `cli:${Date.now().toString(36)}:${randomUUID()}`;
}

export class TaskClient {
  constructor({ client, state, signal, onDiagnostic, sleep } = {}) {
    if (client === undefined || client === null) throw new TypeError("TaskClient requires a WorkflowClient");
    if (state === undefined || state === null) throw new TypeError("TaskClient requires a TaskState");
    this.client = client;
    this.state = state;
    this.signal = signal;
    this.onDiagnostic = onDiagnostic;
    this.sleep =
      sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
  }

  /**
   * Submit an autonomous build exactly once.
   *
   * The local intent is durable before the request leaves, so a lost response
   * can be correlated later. An ambiguous response becomes SUBMISSION_UNKNOWN
   * with the same key; it is never re-POSTed automatically.
   */
  async submit({ submissionKey = newSubmissionKey(), ...input } = {}) {
    const pending = this.state.submission(submissionKey);
    if (pending !== null) {
      return {
        replayed: true,
        submissionKey,
        submission: pending,
        run: null,
        requiresLookup: pending.runId == null,
        runId: pending.runId ?? null,
      };
    }

    await this.state.beginSubmission(submissionKey, {
      request: input.request ?? null,
      repository: input.repository ?? null,
      workspace: input.workspace ?? null,
      mode: input.mode ?? null,
    });

    let result;
    try {
      result = await this.client.submitBuild(input);
    } catch (error) {
      if (error instanceof SdkError && AMBIGUOUS_SUBMISSION_CODES.has(error.code)) {
        await this.state.markSubmission(submissionKey, {
          state: "unknown",
          code: error.code,
        });
        throw new SdkError(
          "SUBMISSION_UNKNOWN",
          `the build submission may or may not have been accepted (${error.code}). ` +
            `It was not retried. Reconcile submission ${submissionKey} with ` +
            "`coderax workflows` and `coderax runs --workflow <id>` before submitting again.",
          {
            status: error.status ?? null,
            details: { submissionKey, code: error.code },
            retryable: false,
          },
        );
      }
      await this.state.markSubmission(submissionKey, {
        state: "failed",
        code: error instanceof SdkError ? error.code : "ERROR",
      });
      throw error;
    }

    await this.state.markSubmission(submissionKey, {
      state: "submitted",
      runId: result.run.id,
    });
    await this.state.recordApplied(result.run, null);
    return { ...result, submissionKey, replayed: false };
  }

  /**
   * Resolve a previously recorded submission without submitting again. This is
   * the recovery path for SUBMISSION_UNKNOWN: it reads durable state only.
   */
  async resumeSubmission(submissionKey) {
    const entry = this.state.submission(submissionKey);
    if (entry === null) {
      throw new SdkError("SUBMISSION_UNKNOWN", `no recorded submission ${submissionKey}`, {
        details: { submissionKey },
      });
    }
    if (typeof entry.runId !== "string" || entry.runId === "") {
      throw new SdkError(
        "SUBMISSION_UNKNOWN",
        `submission ${submissionKey} has no run id; it must be reconciled on the deployment before resubmitting`,
        { details: { submissionKey, state: entry.state ?? null }, retryable: false },
      );
    }
    const run = await this.client.getRun(entry.runId);
    return { run, replayed: true, submissionKey };
  }

  /**
   * Follow one durable run. Rendering happens before state is committed, so a
   * renderer failure does not advance the applied cursor. Reconnects re-read
   * the authoritative snapshot; no synthetic cursor is ever sent.
   */
  async follow(runId, { onRun, signal = this.signal, maxRetries } = {}) {
    let lastRun = this.state.run;
    try {
      const result = await this.client.watchRun(runId, {
        signal,
        ...(maxRetries === undefined ? {} : { maxRetries }),
        onRun: async (run) => {
          // Every authoritative snapshot is offered to the handler. Within one
          // invocation `watchRun` already de-duplicates replayed frames, and a
          // fresh invocation must still be able to render current state or act
          // on a pending approval. Only the recorded cursor/fingerprint and the
          // settlement ledger are persistent; they never suppress an action.
          await onRun?.(run);
          lastRun = run;
        },
        onHandled: async (run, cursor) => {
          await this.state.recordApplied(run, cursor);
        },
      });
      const run = result.run ?? lastRun;
      return { run, outcome: terminalOutcome(run) };
    } catch (error) {
      if (error instanceof SdkError && error.code === "CANCELLED" && signal?.aborted) {
        return {
          run: lastRun,
          outcome: { ...DEFAULT_OUTCOME, kind: "detached", status: lastRun?.status ?? null },
        };
      }
      if (error instanceof SdkError && error.code === "STREAM_INCOMPLETE") {
        return {
          run: lastRun,
          outcome: {
            ...DEFAULT_OUTCOME,
            kind: "disconnected",
            status: lastRun?.status ?? null,
            error: error.message,
          },
        };
      }
      throw error;
    }
  }

  /**
   * Confirm a terminal run with the authoritative read route and de-duplicate
   * the completion notification. There is no backend acknowledgement endpoint;
   * the backend confirmation is the GET, and the ledger is local.
   */
  async settle(runId) {
    const run = await this.client.getRun(runId);
    const outcome = terminalOutcome(run);
    if (!outcome.terminal) {
      return { run, settled: false, newlyAcknowledged: false, acknowledgement: null };
    }
    const acknowledgement = await this.state.recordSettlement(run);
    return {
      run,
      settled: true,
      newlyAcknowledged: acknowledgement.duplicate === false,
      acknowledgement: acknowledgement.key,
      outcome,
    };
  }

  /**
   * Approve a step. A 409 means the server no longer considers that step
   * pending; re-read before deciding whether the action is already satisfied.
   * Ambiguous POSTs are not retried.
   */
  async approve(runId, stepIndex) {
    try {
      const run = await this.client.approveStep(runId, stepIndex);
      await this.state.recordApplied(run, null);
      await this.state.recordApproval(runId, stepIndex, "approved");
      return { run, applied: true, alreadySettled: false };
    } catch (error) {
      if (!(error instanceof SdkError) || error.code !== "CONFLICT") throw error;
      const run = await this.client.getRun(runId);
      const pending = approvalFor(run);
      const alreadySettled =
        run.status !== "waiting_approval" ||
        pending === null ||
        pending.stepIndex !== stepIndex;
      if (!alreadySettled) throw error;
      await this.state.recordApplied(run, null);
      await this.state.recordApproval(runId, stepIndex, "already-settled");
      return { run, applied: false, alreadySettled: true };
    }
  }

  /**
   * Cancel a workflow run. The backend treats a repeated cancellation of a
   * terminal run as a 200 with the existing run, so no retry is needed; a 409
   * is reconciled by reading the run once.
   */
  async cancelRun(runId) {
    try {
      const run = await this.client.cancelRun(runId);
      await this.state.recordApplied(run, null);
      return { run, canceled: run.status === "cancelled", alreadySettled: false };
    } catch (error) {
      if (!(error instanceof SdkError) || error.code !== "CONFLICT") throw error;
      const run = await this.client.getRun(runId);
      await this.state.recordApplied(run, null);
      return {
        run,
        canceled: run.status === "cancelled",
        alreadySettled: isTerminalStatus(run.status),
      };
    }
  }

  /**
   * Cancel a Work task (a conversation). The backend distinguishes a finished
   * task from a task with nothing running; both are reported without retry.
   */
  async cancelTask(taskId) {
    try {
      const result = await this.client.cancelTask(taskId);
      return { result, canceled: true, alreadyFinished: false, nothingToCancel: false };
    } catch (error) {
      if (!(error instanceof SdkError) || error.code !== "CONFLICT") throw error;
      const serverCode = error.details?.serverCode ?? null;
      if (serverCode === "WORK_TASK_ALREADY_FINISHED") {
        return { result: null, canceled: false, alreadyFinished: true, nothingToCancel: false };
      }
      if (serverCode === "WORK_NOTHING_TO_CANCEL") {
        return { result: null, canceled: false, alreadyFinished: false, nothingToCancel: true };
      }
      throw error;
    }
  }

  /** Explicit retry means a fresh run, chosen by the user, never automatic. */
  async retry(runId) {
    const result = await this.client.retryRun(runId);
    await this.state.recordApplied(result.run, null);
    return result;
  }

  /** Read authoritative state without rendering or advancing anything. */
  async confirmRun(runId) {
    const run = await this.client.getRun(runId);
    assertFollowable(run);
    return run;
  }

  /** Resolve a Work task's authoritative state; no invented stream is opened. */
  async readTask(taskId) {
    await this.client.requireCapability(CAPABILITY.workTasks);
    return this.client.getTask(taskId);
  }
}

function assertFollowable(run) {
  if (run === null || typeof run !== "object" || typeof run.id !== "string") {
    throw new SdkError("CONTRACT_VIOLATION", "the deployment returned an invalid run");
  }
}

export { newSubmissionKey };
