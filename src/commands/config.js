import {
  CONFIG_KEYS,
  describeConfig,
  saveConfig,
  unsetConfig,
} from "../config.js";
import { CoderaxError, EXIT, UsageError } from "../errors.js";
import { renderTable } from "../ui/tables.js";

const SET_FLAGS = new Map([
  ["base-url", "baseUrl"],
  ["engine-url", "engineUrl"],
  ["timeout", "timeoutMs"],
  ["chat-path", "chatPath"],
  ["endpoint", "endpoint"],
  ["model", "model"],
  ["agent", "agent"],
  ["credential-store", "credentialStore"],
  ["refresh-command", "refreshCommand"],
  ["theme", "theme"],
  ["output", "output"],
]);

function configValue(runtime, key) {
  const config = runtime.config;
  switch (key) {
    case "base-url": return config.baseUrl;
    case "engine-url": return config.engineUrl;
    case "chat-path": return config.chatPath;
    case "endpoint": return config.endpoint;
    case "model": return config.model || null;
    case "agent": return config.agent || null;
    case "timeout": return config.timeoutMs;
    case "credential-store": return config.credentialStore;
    case "refresh-command": return config.refreshCommand;
    case "theme": return config.theme;
    case "output": return config.output;
    default: return undefined;
  }
}

function showConfig(runtime) {
  const described = describeConfig(runtime.config, { tokenSource: runtime.tokenInfo().source, env: runtime.env });
  const store = runtime.store.describe();
  const data = { ...described, credentialBackend: store.backend, credentialPath: store.path, credentialWarning: store.warning };
  runtime.emit("config.show", data, () => {
    const rows = [
      ["config", described.configPath],
      ["state", runtime.state.filePath],
      ["engine URL", described.engineUrl ?? "(not set)"],
      ["deployment URL", described.baseUrl ?? "(not set)"],
      ["token", described.tokenConfigured ? `configured (${runtime.tokenInfo().masked}, ${described.tokenSource})` : "not configured"],
      ["credential store", store.backend + (store.path ? ` ${store.path}` : "")],
      ["timeout", `${described.timeoutMs}ms`],
      ["agent", described.agent ?? "(engine default)"],
      ["model", described.model ?? "(engine default)"],
      ["refresh helper", described.refreshCommandConfigured ? "configured" : "not configured"],
      ["output", described.output],
      ["theme", described.theme],
    ];
    runtime.write(renderTable({
      headers: ["KEY", "VALUE"],
      rows,
      style: runtime.style,
      width: runtime.width,
    }));
    if (store.warning) runtime.write(runtime.style.yellow(`warning: ${store.warning}`));
  });
  return EXIT.OK;
}

export async function configCommand(runtime, positionals) {
  const action = positionals[0] ?? "show";
  if (action === "show" || action === "list") return showConfig(runtime);
  if (action === "path") {
    runtime.emit("config.path", { config: runtime.configPath, state: runtime.state.filePath, directory: runtime.configDir }, () => {
      runtime.write(runtime.configPath);
      runtime.write(runtime.state.filePath);
    });
    return EXIT.OK;
  }
  if (action === "get") {
    const key = positionals[1];
    if (!key || !Object.hasOwn(CONFIG_KEYS, key)) {
      throw new UsageError(`config get requires one of: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    }
    const value = configValue(runtime, key);
    runtime.emit("config.get", { key, value }, () => runtime.write(value === undefined || value === null ? "(unset)" : typeof value === "string" ? value : JSON.stringify(value)));
    return EXIT.OK;
  }
  if (action === "unset") {
    const keys = positionals.slice(1);
    if (keys.length === 0) throw new UsageError("config unset requires at least one key");
    await unsetConfig(keys, { filePath: runtime.configPath });
    runtime.emit("config.unset", { unset: keys }, () => runtime.write(`unset ${keys.join(", ")}`));
    return EXIT.OK;
  }
  if (action !== "set") throw new UsageError(`unknown config action: ${action}`);

  const patch = {};
  const key = positionals[1];
  const flagNames = [...SET_FLAGS.keys()].filter((name) => runtime.flags.has(name));
  if (key && flagNames.length > 0) {
    throw new UsageError("config set accepts either a key and value or flags, not both");
  }
  if (key) {
    if (!Object.hasOwn(CONFIG_KEYS, key)) throw new UsageError(`unknown config key: ${key}`);
    const value = positionals.slice(2).join(" ").trim();
    if (!value) throw new UsageError(`config set ${key} requires a value`);
    if (value === "auto" && ["model", "agent"].includes(key)) {
      await unsetConfig([key], { filePath: runtime.configPath });
      runtime.emit("config.set", { [key]: null }, () => runtime.write(`unset ${key} (engine default)`));
      return EXIT.OK;
    }
    patch[CONFIG_KEYS[key]] = key === "refresh-command" ? value : value;
  } else {
    for (const [flag, field] of SET_FLAGS) {
      if (!runtime.flags.has(flag)) continue;
      patch[field] = runtime.flags.get(flag);
    }
    if (Object.keys(patch).length === 0) {
      throw new UsageError("config set requires a key and value, or --engine-url/--base-url/--model/--agent/...");
    }
  }
  if (patch.baseUrl !== undefined && patch.baseUrl.trim() === "") throw new UsageError("base-url cannot be empty; use `config unset base-url`");
  if (patch.engineUrl !== undefined && patch.engineUrl.trim() === "") throw new UsageError("engine-url cannot be empty; use `config unset engine-url`");

  const saved = await saveConfig(patch, { filePath: runtime.configPath });
  const keys = Object.keys(patch).filter((field) => field !== "token");
  runtime.emit("config.set", { path: saved.path, keys }, () => {
    runtime.write(`wrote ${saved.path}`);
    for (const field of keys) {
      const value = field === "token" ? "(credential store)" : patch[field];
      runtime.write(`  ${field} = ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  });
  return EXIT.OK;
}

export function assertNoTokenFlag(runtime) {
  if (runtime.flags.has("token")) {
    throw new CoderaxError("USAGE", "the owner token is stored by `coderax login`, not by `config set`");
  }
}
