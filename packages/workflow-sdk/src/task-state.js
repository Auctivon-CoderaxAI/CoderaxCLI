import { runFingerprint, terminalOutcome } from "./task-events.js";

/**
 * Durable client-side task state.
 *
 * The rule this class exists to enforce is narrow and important: a cursor or an
 * applied fingerprint is recorded only after the caller's handler has resolved
 * successfully. A failed render or a rejected approval therefore re-delivers
 * the same authoritative snapshot instead of silently skipping it.
 *
 * Snapshots are idempotent, so `appliedFingerprint` is the resume identity when
 * the deployment supplies no SSE ids. `cursor` is stored only when the
 * deployment actually supplied one (see `cursorFromFrame`). Nothing here
 * invents an event ordinal.
 */

export const TASK_STATE_VERSION = 1;

const MAX_SUBMISSIONS = 20;
const MAX_SETTLEMENTS = 50;
const MAX_APPROVALS = 50;

function boundedPut(map, key, value, limit) {
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function settlementKey(run) {
  if (!isObject(run) || typeof run.id !== "string") return null;
  return `${run.id}|${run.status}|${typeof run.settledAt === "string" ? run.settledAt : ""}`;
}

export class TaskState {
  constructor({ persist = null, onPersistError = null } = {}) {
    this.persist = persist;
    this.onPersistError = onPersistError;
    this.run = null;
    this.appliedFingerprint = null;
    this.cursor = null;
    this.terminal = null;
    this.submissions = new Map();
    this.settlements = new Map();
    this.approvals = new Map();
  }

  /** Restore a persisted document without trusting its shape. */
  restore(document) {
    if (!isObject(document)) return this;
    this.run = isObject(document.run) ? document.run : null;
    this.appliedFingerprint =
      typeof document.appliedFingerprint === "string" ? document.appliedFingerprint : null;
    this.cursor =
      isObject(document.cursor) &&
      (document.cursor.kind === "event-id" || document.cursor.kind === "sequence") &&
      (typeof document.cursor.value === "string" || Number.isInteger(document.cursor.value))
        ? { kind: document.cursor.kind, value: document.cursor.value }
        : null;
    this.terminal = isObject(document.terminal) ? document.terminal : null;
    if (isObject(document.submissions)) {
      for (const [key, entry] of Object.entries(document.submissions)) {
        if (isObject(entry)) this.submissions.set(key, entry);
      }
    }
    if (isObject(document.settlements)) {
      for (const [key, entry] of Object.entries(document.settlements)) {
        if (isObject(entry)) this.settlements.set(key, entry);
      }
    }
    if (isObject(document.approvals)) {
      for (const [key, entry] of Object.entries(document.approvals)) {
        if (isObject(entry)) this.approvals.set(key, entry);
      }
    }
    return this;
  }

  snapshot() {
    return {
      version: TASK_STATE_VERSION,
      run: this.run,
      appliedFingerprint: this.appliedFingerprint,
      cursor: this.cursor,
      terminal: this.terminal,
      submissions: Object.fromEntries(this.submissions),
      settlements: Object.fromEntries(this.settlements),
      approvals: Object.fromEntries(this.approvals),
    };
  }

  async #save() {
    if (this.persist === null) return true;
    try {
      await this.persist(this.snapshot());
      return true;
    } catch (error) {
      // The authoritative action already succeeded. Losing the local copy may
      // cause a duplicate render or notification later; it must not corrupt the
      // live turn, so report it instead of throwing mid-stream.
      this.onPersistError?.(error);
      return false;
    }
  }

  isDuplicate(run) {
    return this.appliedFingerprint !== null && runFingerprint(run) === this.appliedFingerprint;
  }

  /**
   * Commit one successfully handled snapshot. `cursor` may be null: a
   * snapshot-only stream has no authoritative cursor to persist.
   */
  async recordApplied(run, cursor = null) {
    if (!isObject(run) || typeof run.id !== "string" || run.id === "") {
      throw new TypeError("recordApplied requires a run with an id");
    }
    this.run = run;
    this.appliedFingerprint = runFingerprint(run);
    if (
      isObject(cursor) &&
      (cursor.kind === "event-id" || cursor.kind === "sequence") &&
      (typeof cursor.value === "string" || Number.isInteger(cursor.value))
    ) {
      this.cursor = { kind: cursor.kind, value: cursor.value };
    }
    const outcome = terminalOutcome(run);
    if (outcome.terminal) {
      this.terminal = {
        status: outcome.status,
        kind: outcome.kind,
        settledAt: outcome.settledAt,
        error: outcome.error,
      };
    }
    return this.#save();
  }

  /** A terminal run is latched: a late non-terminal snapshot cannot undo it. */
  accepts(run) {
    if (this.terminal === null) return true;
    const outcome = terminalOutcome(run);
    if (outcome.terminal) return outcome.status === this.terminal.status || outcome.status !== null;
    return false;
  }

  /**
   * Record that the backend-confirmed terminal state has been delivered to the
   * user. This is a local de-duplication ledger, not a backend delivery receipt;
   * there is no client-facing settlement-ack route. See EVENT-PROTOCOL.md.
   */
  async recordSettlement(run) {
    const key = settlementKey(run);
    if (key === null) throw new TypeError("recordSettlement requires a terminal run with an id");
    if (this.settlements.has(key)) {
      return { duplicate: true, key };
    }
    boundedPut(this.settlements, key, { at: new Date().toISOString() }, MAX_SETTLEMENTS);
    await this.#save();
    return { duplicate: false, key };
  }

  settlement(run) {
    const key = settlementKey(run);
    return key === null ? null : this.settlements.get(key) ?? null;
  }

  /**
   * A submission intent is written before the POST. It correlates an ambiguous
   * response with the request the user already sent; it is not a backend
   * idempotency guarantee, because `/api/workflows/builds` accepts none.
   */
  async beginSubmission(key, intent) {
    if (typeof key !== "string" || key === "") throw new TypeError("a submission key is required");
    if (this.submissions.has(key)) return { replayed: true, entry: this.submissions.get(key) };
    boundedPut(
      this.submissions,
      key,
      { state: "pending", createdAt: new Date().toISOString(), intent },
      MAX_SUBMISSIONS,
    );
    await this.#save();
    return { replayed: false, entry: this.submissions.get(key) };
  }

  async markSubmission(key, patch) {
    const current = this.submissions.get(key);
    if (current === undefined) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    boundedPut(this.submissions, key, next, MAX_SUBMISSIONS);
    await this.#save();
    return next;
  }

  submission(key) {
    return this.submissions.get(key) ?? null;
  }

  async recordApproval(runId, stepIndex, outcome) {
    const key = `${runId}|${stepIndex}`;
    boundedPut(
      this.approvals,
      key,
      { outcome, at: new Date().toISOString() },
      MAX_APPROVALS,
    );
    await this.#save();
    return key;
  }

  approval(runId, stepIndex) {
    return this.approvals.get(`${runId}|${stepIndex}`) ?? null;
  }
}
