import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./config.js";

/**
 * Task synchronisation state is local bookkeeping: applied snapshot identity,
 * a cursor only when the deployment issued one, submission intents, approval
 * results and the completion-notification ledger. It contains no message text
 * and no credentials, so it lives beside the config rather than inside it and
 * is never printed.
 */

export function taskStatePath(env = process.env, baseUrl = null) {
  const override = env.CODERAX_TASK_STATE?.trim();
  if (override && override !== "") return override;
  // State is per deployment: a snapshot applied against one deployment must
  // never suppress handling of the same run id on another. When the config
  // file is explicitly placed (tests, CODERAX_CONFIG), state lives beside it.
  const directory = env.CODERAX_CONFIG?.trim()
    ? dirname(env.CODERAX_CONFIG.trim())
    : configDir(env);
  if (baseUrl === null || baseUrl === "") return join(directory, "tasks.json");
  const digest = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
  return join(directory, `tasks-${digest}.json`);
}

export async function readTaskState(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createFileTaskStateStore(path) {
  return {
    load: () => readTaskState(path),
    persist: async (snapshot) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          throw new Error(`${path} is a symbolic link; refusing to write task state through it`);
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
