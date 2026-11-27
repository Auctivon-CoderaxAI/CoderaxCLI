/**
 * Durable submission ledger for `/v1` Work.
 *
 * The ledger is what makes at-most-once submission survive a crash: the key is
 * written before the request leaves the process. It therefore lives in a private
 * file next to the config, written with the repository's own secure writer
 * (0600 on POSIX, an owner-only ACL on Windows) and never contains an objective
 * longer than a short excerpt, a token, or any engine output.
 *
 * Entries are namespaced by deployment so two different engines cannot collide
 * on a key.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./legacy-config.js";
import { readSecureFile, writeSecureFile, SecureStoreError } from "./secure-store.js";

const MAX_SUBMISSIONS = 200;
const MAX_TASKS = 200;

function emptyLedger() {
  return { version: 1, deployments: {} };
}

function bucketKey(baseUrl) {
  return createHash("sha256").update(String(baseUrl ?? "").replace(/\/+$/, "")).digest("hex").slice(0, 16);
}

function normalizeEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  return entry;
}

/** Drop the oldest entries so one busy deployment cannot grow the file forever. */
function cap(record, limit) {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  const ordered = keys
    .map((key) => [key, Date.parse(record[key]?.updatedAt ?? record[key]?.createdAt ?? "") || 0])
    .sort((a, b) => a[1] - b[1]);
  const keep = new Set(ordered.slice(ordered.length - limit).map(([key]) => key));
  const next = {};
  for (const key of keys) if (keep.has(key)) next[key] = record[key];
  return next;
}

export function submissionLedgerPath(env = process.env) {
  return join(configDir(env), "submissions.json");
}

/**
 * @param {object} options
 * @param {string} options.baseUrl deployment the ledger is scoped to
 * @param {string} [options.path]
 * @param {object} [options.env]
 * @param {object} [options.deps] injected fs/security dependencies for tests
 */
export function createSubmissionLedger({ baseUrl, path, env = process.env, deps = {} } = {}) {
  const filePath = path ?? submissionLedgerPath(env);
  const key = bucketKey(baseUrl);
  let loaded = null;
  let queue = Promise.resolve();

  async function load() {
    if (loaded !== null) return loaded;
    // Distinguish "no ledger yet" from "the ledger is not private". The secure
    // reader reports a missing file as STORE_PERMISSIONS, so existence is
    // checked first; only a real permission failure is allowed to propagate.
    try {
      await stat(filePath);
    } catch {
      loaded = emptyLedger();
      return loaded;
    }
    let raw;
    try {
      raw = await readSecureFile(filePath, deps);
    } catch (error) {
      if (error instanceof SecureStoreError && error.code === "STORE_PERMISSIONS") throw error;
      loaded = emptyLedger();
      return loaded;
    }
    try {
      const parsed = JSON.parse(raw);
      const deployments = parsed?.deployments;
      loaded = {
        version: 1,
        deployments: deployments !== null && typeof deployments === "object" && !Array.isArray(deployments)
          ? deployments
          : {},
      };
    } catch {
      // A corrupt ledger is treated as empty rather than losing the CLI. The
      // consequence is conservative: an unknown key is reported as unknown.
      loaded = emptyLedger();
    }
    return loaded;
  }

  function bucket(state) {
    state.deployments[key] ??= { submissions: {}, tasks: {} };
    const entry = state.deployments[key];
    entry.submissions ??= {};
    entry.tasks ??= {};
    return entry;
  }

  /**
   * Serialise writes so two concurrent submissions cannot lose one another.
   */
  function mutate(fn) {
    const run = queue.then(async () => {
      const state = await load();
      const entry = bucket(state);
      const result = fn(entry);
      await writeSecureFile(filePath, `${JSON.stringify(state, null, 2)}\n`, deps);
      return result;
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    path: filePath,

    async submission(submissionKey) {
      const state = await load();
      return normalizeEntry(bucket(state).submissions[submissionKey] ?? null);
    },

    async upsertSubmission(submissionKey, patch) {
      await mutate((entry) => {
        entry.submissions[submissionKey] = {
          ...(entry.submissions[submissionKey] ?? {}),
          ...patch,
          submissionKey,
        };
        entry.submissions = cap(entry.submissions, MAX_SUBMISSIONS);
      });
    },

    async task(taskId) {
      const state = await load();
      return normalizeEntry(bucket(state).tasks[taskId] ?? null);
    },

    async upsertTask(record) {
      await mutate((entry) => {
        entry.tasks[record.taskId] = { ...(entry.tasks[record.taskId] ?? {}), ...record };
        entry.tasks = cap(entry.tasks, MAX_TASKS);
      });
    },

    async listTasks() {
      const state = await load();
      return Object.values(bucket(state).tasks).sort(
        (a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0),
      );
    },
  };
}
