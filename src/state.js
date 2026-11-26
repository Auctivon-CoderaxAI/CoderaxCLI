import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    active: {
      mode: "chat",
      chatConversationId: null,
      workConversationId: null,
      agent: null,
      model: null,
    },
    tasks: {},
    submissions: {},
    notifications: { seen: {} },
    history: { chat: [], work: [] },
    preferences: { theme: "auto" },
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repair(raw) {
  const base = emptyState();
  if (!isObject(raw)) return { state: base, repaired: true };
  const state = {
    ...base,
    ...raw,
    active: { ...base.active, ...(isObject(raw.active) ? raw.active : {}) },
    tasks: isObject(raw.tasks) ? raw.tasks : {},
    submissions: isObject(raw.submissions) ? raw.submissions : {},
    notifications: {
      seen: isObject(raw.notifications?.seen) ? raw.notifications.seen : {},
    },
    history: {
      chat: Array.isArray(raw.history?.chat) ? raw.history.chat.filter((entry) => typeof entry === "string").slice(-500) : [],
      work: Array.isArray(raw.history?.work) ? raw.history.work.filter((entry) => typeof entry === "string").slice(-500) : [],
    },
    preferences: { ...base.preferences, ...(isObject(raw.preferences) ? raw.preferences : {}) },
    version: STATE_VERSION,
  };
  return { state, repaired: raw.version !== STATE_VERSION };
}

async function defaultLock(path) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
      await handle.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Another process may have recovered a stale lock.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 10_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw Object.assign(new Error(`state is locked: ${lockPath}`), { code: "STATE_LOCKED" });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}

/**
 * The engine is authoritative for conversations and tasks. This journal exists
 * so a terminal can resume a detached task, deduplicate a submission, show a
 * notification indicator and keep local history across invocations.
 */
export class StateStore {
  constructor({
    filePath,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    renameImpl = rename,
    unlinkImpl = unlink,
    mkdirImpl = mkdir,
    chmodImpl = chmod,
    lockImpl = defaultLock,
  } = {}) {
    if (!filePath) throw new Error("a state file path is required");
    this.filePath = filePath;
    this.readFileImpl = readFileImpl;
    this.writeFileImpl = writeFileImpl;
    this.renameImpl = renameImpl;
    this.unlinkImpl = unlinkImpl;
    this.mkdirImpl = mkdirImpl;
    this.chmodImpl = chmodImpl;
    this.lockImpl = lockImpl;
    this.cached = null;
    this.warnings = [];
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.cached) return this.cached;
    try {
      const raw = await this.readFileImpl(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const { state, repaired } = repair(parsed);
      if (repaired) {
        this.warnings.push("the local state file had an older shape and was repaired");
        this.cached = state;
        await this.#write(state);
      } else {
        this.cached = state;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cached = emptyState();
      } else {
        const quarantine = `${this.filePath}.corrupt-${Date.now().toString(36)}`;
        try {
          await this.renameImpl(this.filePath, quarantine);
          this.warnings.push(`the local state file was unreadable and was moved to ${quarantine}`);
        } catch {
          this.warnings.push("the local state file was unreadable and was reset");
        }
        this.cached = emptyState();
      }
    }
    return this.cached;
  }

  async snapshot() {
    await this.load();
    return this.cached;
  }

  async #write(state) {
    await this.mkdirImpl(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await this.writeFileImpl(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      try {
        await this.chmodImpl(temp, 0o600);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      await this.renameImpl(temp, this.filePath);
    } catch (error) {
      try {
        await this.unlinkImpl(temp);
      } catch {
        // Ignore.
      }
      throw error;
    }
  }

  /** Serialize every read-modify-write across processes and within this one. */
  async update(mutator) {
    const run = async () => {
      const release = await this.lockImpl(this.filePath);
      try {
        // Re-read under the lock: another terminal may have written since this
        // process cached the journal.
        this.cached = null;
        const state = await this.load();
        const next = await mutator(state);
        const resolved = next ?? state;
        this.cached = resolved;
        await this.#write(resolved);
        return resolved;
      } finally {
        await release();
      }
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async task(taskId) {
    const state = await this.load();
    return state.tasks[taskId] ?? null;
  }

  async findTaskForConversation(conversationId) {
    const state = await this.load();
    return Object.values(state.tasks)
      .filter((task) => task.conversationId === conversationId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  }

  async listTasks({ limit = 50 } = {}) {
    const state = await this.load();
    return Object.values(state.tasks)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  async upsertTask(task) {
    const patch = Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined));
    return this.update((state) => {
      state.tasks[task.taskId] = { ...(state.tasks[task.taskId] ?? {}), ...patch };
      return state;
    });
  }

  async submission(key) {
    const state = await this.load();
    return state.submissions[key] ?? null;
  }

  async upsertSubmission(key, patch) {
    return this.update((state) => {
      state.submissions[key] = { ...(state.submissions[key] ?? {}), ...patch, key };
      return state;
    });
  }

  async markNotificationSeen(key) {
    return this.update((state) => {
      state.notifications.seen[key] = new Date().toISOString();
      return state;
    });
  }

  async isNotificationSeen(key) {
    const state = await this.load();
    return Boolean(state.notifications.seen[key]);
  }

  async setActive(patch) {
    return this.update((state) => {
      state.active = { ...state.active, ...patch };
      return state;
    });
  }

  async addHistory(mode, entry) {
    return this.update((state) => {
      const list = state.history[mode] ?? [];
      if (list[list.length - 1] !== entry) list.push(entry);
      state.history[mode] = list.slice(-500);
      return state;
    });
  }
}

export function taskRecord({ accepted, conversationId, objective, agent, mode, model, submissionId, now = new Date().toISOString() }) {
  return {
    taskId: accepted.taskId,
    conversationId: accepted.conversationId ?? conversationId ?? null,
    objective,
    agent: agent ?? null,
    mode: mode ?? "cloud",
    model: model ?? null,
    submissionId: submissionId ?? null,
    state: accepted.state ?? "queued",
    generation: accepted.generation ?? 0,
    lastSeq: 0,
    detached: false,
    createdAt: now,
    updatedAt: now,
  };
}
