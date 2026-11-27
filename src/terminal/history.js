/**
 * Privacy-preserving local history.
 *
 * Only prompts can be retained, never responses, tool output, credentials or
 * file contents. Prompts that look like they contain a secret, or that
 * reference a local file for upload, are not written to disk at all. Retention
 * is configurable and history can be cleared or disabled entirely.
 */

import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readSecureFile, removeSecureFile, writeSecureFile } from "../secure-store.js";
import { sanitizeOneLine, sanitizeTerminalText } from "./sanitize.js";

export const DEFAULT_HISTORY = Object.freeze({
  enabled: true,
  maxEntries: 200,
  retentionDays: 30,
});

const MAX_PROMPT_CHARS = 4000;
const MAX_CONVERSATIONS = 50;
const SENSITIVE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(password|passphrase|passwd|pwd)\s*[:=]\s*\S+/i,
  /\b(api[-_ ]?key|secret|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*\S+/i,
  /\bauthorization\s*:\s*bearer\s+\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b[0-9a-f]{32,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
]);

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

/** Merge stored and environment settings into a bounded configuration. */
export function normalizeHistorySettings(raw = {}, env = {}) {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  let enabled = source.enabled !== false;
  const flag = String(env.CODERAX_HISTORY ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") enabled = false;
  if (flag === "on" || flag === "1" || flag === "true") enabled = true;
  return {
    enabled,
    maxEntries: clampInteger(
      env.CODERAX_HISTORY_MAX_ENTRIES ?? source.maxEntries,
      1,
      2000,
      DEFAULT_HISTORY.maxEntries,
    ),
    retentionDays: clampInteger(
      env.CODERAX_HISTORY_RETENTION_DAYS ?? source.retentionDays,
      1,
      3650,
      DEFAULT_HISTORY.retentionDays,
    ),
  };
}

/** A prompt that must never reach disk. */
export function isSensitivePrompt(text) {
  const value = String(text ?? "");
  if (value.trim() === "") return false;
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // A local-file reference can disclose a private path (and the referenced
  // content is transmitted separately, with its own authorisation).
  if (/(^|\s)@"?[^"\s]+/.test(value)) return true;
  return false;
}

export function historyPathFor(configPath, env = {}) {
  if (env.CODERAX_HISTORY_FILE?.trim()) return env.CODERAX_HISTORY_FILE.trim();
  return join(dirname(configPath), "history.json");
}

function cleanPrompt(text) {
  return sanitizeTerminalText(String(text ?? ""), { maxChars: MAX_PROMPT_CHARS })
    .replace(/\s+$/, "");
}

/**
 * Bounded prompt history. `add()` never throws because of storage problems;
 * the caller can surface `stored: false` instead of losing the conversation.
 */
export class PromptHistory {
  constructor({ path, settings, entries = [], deps = {}, now = () => Date.now() } = {}) {
    this.path = path;
    this.settings = normalizeHistorySettings(settings);
    this.deps = deps;
    this.now = now;
    this.entries = entries;
  }

  static async open({ path, settings, deps = {}, now = () => Date.now() } = {}) {
    const normalized = normalizeHistorySettings(settings);
    const history = new PromptHistory({ path, settings: normalized, deps, now });
    if (!normalized.enabled) return history;
    try {
      const raw = await readSecureFile(path, deps);
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      history.entries = entries
        .filter((entry) => entry && typeof entry.text === "string")
        .map((entry) => ({
          text: cleanPrompt(entry.text),
          at: Number(entry.at) || history.now(),
          mode: entry.mode === "work" ? "work" : "chat",
        }))
        .filter((entry) => entry.text !== "");
      history.prune();
    } catch (error) {
      // A missing file is normal. A corrupt or insecure one is ignored, not
      // trusted, and not repaired silently with its contents.
      if (error?.code !== "ENOENT" && error?.code !== "STORE_PERMISSIONS") history.loadError = error?.code ?? "read failed";
    }
    return history;
  }

  get enabled() {
    return this.settings.enabled;
  }

  get maxEntries() {
    return this.settings.maxEntries;
  }

  get retentionDays() {
    return this.settings.retentionDays;
  }

  prune(at = this.now()) {
    const cutoff = at - this.retentionDays * 24 * 60 * 60 * 1000;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    return this.entries.length;
  }

  list() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  at(index) {
    return this.entries[index] ? { ...this.entries[index] } : null;
  }

  get size() {
    return this.entries.length;
  }

  async add(text, { mode = "chat" } = {}) {
    if (!this.enabled) return { stored: false, reason: "disabled" };
    const prompt = cleanPrompt(text);
    if (prompt.trim() === "") return { stored: false, reason: "empty" };
    if (isSensitivePrompt(prompt)) return { stored: false, reason: "sensitive" };
    const last = this.entries[this.entries.length - 1];
    if (last && last.text === prompt && last.mode === mode) return { stored: true, deduped: true };
    this.entries.push({ text: prompt, at: this.now(), mode });
    this.prune();
    try {
      await this.persist();
      return { stored: true };
    } catch (error) {
      return { stored: false, reason: "write-failed", error: error?.code ?? "error" };
    }
  }

  async persist() {
    if (!this.enabled || !this.path) return;
    await writeSecureFile(
      this.path,
      `${JSON.stringify({ version: 1, updatedAt: this.now(), entries: this.entries }, null, 2)}\n`,
      this.deps,
    );
  }

  async clear() {
    this.entries = [];
    if (!this.path) return;
    try {
      await removeSecureFile(this.path, this.deps);
    } catch {
      // Already gone is fine.
    }
  }

  async setEnabled(enabled) {
    this.settings = { ...this.settings, enabled: Boolean(enabled) };
    if (!this.settings.enabled) await this.clear();
  }

  setRetentionDays(days) {
    this.settings = {
      ...this.settings,
      retentionDays: clampInteger(days, 1, 3650, this.settings.retentionDays),
    };
    this.prune();
  }

  async setMaxEntries(count) {
    this.settings = {
      ...this.settings,
      maxEntries: clampInteger(count, 1, 2000, this.settings.maxEntries),
    };
    this.prune();
    if (this.enabled) await this.persist().catch(() => {});
  }
}

function conversationTitle(prompt, enabled) {
  if (!enabled || isSensitivePrompt(prompt)) return "Untitled session";
  return sanitizeOneLine(prompt, 60) || "Untitled session";
}

/**
 * Conversation metadata only: identifiers, mode, model, agent, a bounded title
 * and timestamps. Prompt bodies and responses are never stored here.
 */
export class ConversationStore {
  constructor({ path, enabled = true, maxEntries = MAX_CONVERSATIONS, deps = {}, now = () => Date.now() } = {}) {
    this.path = path;
    this.enabled = enabled;
    this.maxEntries = Math.min(MAX_CONVERSATIONS, maxEntries);
    this.deps = deps;
    this.now = now;
    this.entries = [];
  }

  static async open(options = {}) {
    const store = new ConversationStore(options);
    if (!store.path) return store;
    try {
      const raw = await readSecureFile(store.path, store.deps);
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.conversations) ? parsed.conversations : [];
      store.entries = entries
        .filter((entry) => entry && typeof entry.id === "string")
        .map((entry) => ({
          id: entry.id,
          mode: entry.mode === "work" ? "work" : "chat",
          model: typeof entry.model === "string" ? entry.model : "",
          agent: typeof entry.agent === "string" ? entry.agent : "",
          conversationId: typeof entry.conversationId === "string" ? entry.conversationId : null,
          title: sanitizeOneLine(entry.title ?? "Untitled session", 60),
          createdAt: Number(entry.createdAt) || store.now(),
          updatedAt: Number(entry.updatedAt) || store.now(),
        }))
        .slice(-store.maxEntries);
    } catch {
      // Missing or unreadable metadata simply starts empty.
    }
    return store;
  }

  list() {
    return this.entries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({ ...entry }));
  }

  find(id) {
    const entry = this.entries.find((item) => item.id === id || item.conversationId === id);
    return entry ? { ...entry } : null;
  }

  async upsert({
    id,
    mode = "chat",
    model = "",
    agent = "",
    conversationId = null,
    prompt = "",
    now = this.now(),
  } = {}) {
    const existing = id ? this.entries.find((entry) => entry.id === id || entry.conversationId === id) : null;
    const entry = existing ?? {
      id: conversationId ?? randomUUID(),
      createdAt: now,
      title: conversationTitle(prompt, this.enabled),
    };
    entry.mode = mode === "work" ? "work" : "chat";
    entry.model = String(model ?? "");
    entry.agent = String(agent ?? "");
    if (conversationId) entry.conversationId = String(conversationId);
    entry.updatedAt = now;
    if (!existing) this.entries.push(entry);
    this.entries = this.entries.slice(-this.maxEntries);
    if (this.enabled) {
      try {
        await this.persist();
      } catch {
        // Metadata is a convenience; a failure must not fail the conversation.
      }
    }
    return { ...entry };
  }

  async persist() {
    if (!this.path || !this.enabled) return;
    await writeSecureFile(
      this.path,
      `${JSON.stringify({ version: 1, updatedAt: this.now(), conversations: this.entries }, null, 2)}\n`,
      this.deps,
    );
  }

  async clear() {
    this.entries = [];
    if (!this.path) return;
    try {
      await removeSecureFile(this.path, this.deps);
    } catch {
      // Already gone.
    }
  }
}

export function fingerprintPrompt(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 12);
}
