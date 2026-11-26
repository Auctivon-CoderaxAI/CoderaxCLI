import { createHash } from "node:crypto";
import { CoderaxError } from "./errors.js";
import { loadToken, maskToken } from "./config.js";
import { runCommand, validateSecret } from "./credentials.js";

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

/**
 * The owner token is read from the OS credential store, an environment variable
 * or a one-shot flag. `refresh` is the only path that can replace it at runtime:
 * it re-reads the store and, when configured, runs the owner's refresh helper
 * with a sanitized environment and no inherited credential.
 */
export async function createTokenProvider({
  config,
  env = process.env,
  store,
  flagToken,
  runner = runCommand,
  onWarning = () => {},
} = {}) {
  let current = await loadToken({ config, env, store, flagToken });
  let refreshing = null;

  async function get() {
    if (!current.token) {
      throw new CoderaxError(
        "UNAUTHENTICATED",
        "no owner token is configured; run `coderax login` or set CODERAX_TOKEN",
        { hint: "`coderax login` stores the token in the operating system credential store." },
      );
    }
    return current.token;
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      // Another terminal may have completed `coderax login` since startup.
      const stored = await loadToken({ config, env, store });
      if (stored.token && stored.token !== current.token) {
        current = stored;
        return current.token;
      }

      if (!Array.isArray(config?.refreshCommand) || config.refreshCommand.length === 0) {
        throw new CoderaxError(
          "AUTH_REFRESH_UNAVAILABLE",
          "the token was rejected and no refresh command is configured",
          { hint: "Run `coderax login` again, or set a refresh helper with `coderax config set refresh-command '[\"command\",\"arg\"]'`." },
        );
      }

      const result = await runner(config.refreshCommand[0], config.refreshCommand.slice(1), {
        env,
        timeoutMs: 15_000,
        maxBytes: 16 * 1024,
      });
      if (result.error?.code === "ENOENT") {
        throw new CoderaxError("AUTH_REFRESH_FAILED", "the configured refresh command could not be started");
      }
      if (result.code !== 0) {
        throw new CoderaxError("AUTH_REFRESH_FAILED", `the configured refresh command exited ${result.code ?? "without a status"}`);
      }
      const candidate = result.stdout.trim();
      let next;
      try {
        next = validateSecret(candidate);
      } catch {
        throw new CoderaxError("AUTH_REFRESH_FAILED", "the refresh command did not print a valid owner token");
      }
      if (store) {
        const written = await store.write(next);
        if (written?.warning) onWarning(written.warning);
      }
      current = { token: next, source: "refresh-command" };
      return next;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return {
    get,
    refresh,
    describe() {
      return {
        configured: Boolean(current.token),
        source: current.source,
        masked: maskToken(current.token),
        refreshCommandConfigured: Array.isArray(config?.refreshCommand),
        fingerprint: current.token ? hash(current.token) : null,
      };
    },
    setToken(token, source = "login") {
      current = { token, source };
    },
    peek() {
      return current.token;
    },
  };
}
