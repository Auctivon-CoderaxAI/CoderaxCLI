#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  saveConfig,
} from "./config.js";
import { CoderaxError, formatJson, redact, request } from "./client.js";
import { discoverOpenApi } from "./discover.js";
import * as engine from "./engine-commands.js";
import * as product from "./product-commands.js";
import { CONTRACT_VERSION, DATA_MODES, KNOWN_AGENTS } from "./contract.js";
import { VERSION } from "./version.js";

export { VERSION };

const USAGE = `coderax ${VERSION} - owner-only terminal client for a Coderax WorkflowEngine

Usage:
  coderax login [--token <token>] [--json]
  coderax logout [--json]
  coderax status [--json]
  coderax health [--json]
  coderax ready [--json]
  coderax doctor [--json]
  coderax capabilities [--json]
  coderax agents [--json]
  coderax models [--json]

  coderax chat [message] [--agent <id>] [--model <provider/model>]
                      [--mode private|cloud] [--conversation <id>] [--json]
  coderax work [message] [--agent <id>] [--model <provider/model>]
                      [--mode private|cloud] [--conversation <id>]
                      [--detach] [--no-approval] [--after <seq>] [--json]
  coderax task <taskId> [--json]
  coderax tasks [--json]
  coderax events <taskId> [--after <seq>] [--once] [--json]
  coderax cancel <taskId> [--reason <text>] [--json]
  coderax resume <taskId> [--generation <n>] [--json]
  coderax retry <taskId> [--generation <n>] [--model <provider/model>] [--json]
  coderax permissions <taskId> [--json]
  coderax approve <taskId> <requestId> [--reason <text>] [--json]
  coderax deny <taskId> <requestId> [--reason <text>] [--json]
  coderax notifications [--json]
  coderax conversations [--json]
  coderax conversation <conversationId> [--json]
  coderax memory [--mode private|cloud] [--json]
  coderax artifacts <taskId> [--json]

  coderax products [--json]
  coderax cloud [--json]
  coderax projects [--json]
  coderax update [--json]
  coderax config show|list [--json]
  coderax config get <key>
  coderax config set <key> <value>
  coderax config set [--base-url <url>] [--token <token>] [--timeout <ms>]
  coderax openapi [--json]
  coderax call <METHOD> <PATH> [--data <json>] [--json]

Global options:
  --base-url <url>   Override the engine URL (HTTPS, or HTTP on loopback)
  --token <token>    Override the configured owner token
  --timeout <ms>     Per-request timeout, 100-120000
  --event-timeout <ms>  Event-stream idle timeout, 1000-600000
  --agent <id>       coderax, opencode, or freebuff
  --model <ref>      <provider>/<model>; paid models are refused by the engine
  --mode <mode>      private or cloud
  --json             Machine-readable output
  --no-color         Accepted for compatibility
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  CODERAX_BASE_URL, CODERAX_TOKEN, CODERAX_TIMEOUT_MS,
  CODERAX_EVENT_TIMEOUT_MS, CODERAX_AGENT, CODERAX_MODE,
  CODERAX_MODEL, CODERAX_CONFIG, CODERAX_CONFIG_DIR

The CLI targets the versioned WorkflowEngine contract ${CONTRACT_VERSION}.
Streaming is available on Work tasks; Chat is a single request in contract 1.0.0.
A Work task continues on the engine when this client detaches or exits.
`;

const EXIT = Object.freeze({
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 3,
  network: 4,
  notFound: 5,
  unavailable: 6,
  cancelled: 130,
});

const CONFIG_KEYS = Object.freeze(Object.assign(Object.create(null), {
  "base-url": "baseUrl",
  "chat-path": "chatPath",
  endpoint: "endpoint",
  model: "model",
  agent: "agent",
  mode: "mode",
  "event-timeout": "eventTimeoutMs",
}));
const CONFIG_FLAGS = ["base-url", "token", "timeout", "chat-path", "endpoint", "model", "agent", "mode", "event-timeout"];

const KNOWN_COMMANDS = new Set([
  "config",
  "health",
  "ready",
  "openapi",
  "agents",
  "models",
  "call",
  "products",
  "chat",
  "work",
  "task",
  "tasks",
  "events",
  "cancel",
  "resume",
  "retry",
  "permissions",
  "approve",
  "deny",
  "notifications",
  "conversations",
  "conversation",
  "memory",
  "artifacts",
  "capabilities",
  "caps",
  "cloud",
  "projects",
  "login",
  "logout",
  "status",
  "doctor",
  "update",
  "help",
  "version",
]);
const KNOWN_FLAGS = new Set([
  "help",
  "version",
  "json",
  "base-url",
  "token",
  "timeout",
  "event-timeout",
  "data",
  "model",
  "endpoint",
  "chat-path",
  "url",
  "no-color",
  "agent",
  "mode",
  "conversation",
  "detach",
  "after",
  "once",
  "reason",
  "generation",
  "no-approval",
]);
const BOOLEAN_FLAGS = new Set(["detach", "once", "no-approval"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgv(argv) {
  const flags = new Map();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (arg === "--json") {
      flags.set("json", true);
      continue;
    }
    if (arg === "--no-color") {
      flags.set("no-color", true);
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      if (!KNOWN_FLAGS.has(name)) {
        throw new UsageError(`unknown option: --${name}`);
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (equals !== -1) throw new UsageError(`--${name} does not take a value`);
        flags.set(name, true);
        continue;
      }
      if (equals !== -1) {
        flags.set(name, body.slice(equals + 1));
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} requires a value`);
      }
      flags.set(name, value);
      index += 1;
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals };
}

function emit(write, flags, human, machine) {
  write(flags.has("json") ? formatJson(machine) : human);
}

function responseBody(response) {
  return response.text.trim() === "null" ? null : response.json ?? response.text;
}

/**
 * Validate everything that does not need configuration before touching the
 * config file, so a typo reports a usage error instead of a missing base URL.
 */
function preflight(positionals, flags) {
  const [command] = positionals;
  let call = null;

  if (!KNOWN_COMMANDS.has(command)) {
    throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
  }

  if (command === "config") {
    const action = positionals[1] ?? "show";
    if (!["show", "list", "get", "set"].includes(action)) {
      throw new UsageError(`unknown config action: ${action}`);
    }
    if (action === "get" && (!positionals[2] || !(positionals[2] in CONFIG_KEYS))) {
      throw new UsageError(`config get requires one of: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    }
    if (action === "set") {
      const key = positionals[2];
      const hasFlags = CONFIG_FLAGS.some((name) => flags.has(name));
      if (!hasFlags && !key) {
        throw new UsageError("config set requires a key and value, or --base-url/--token/--timeout");
      }
      if (key && hasFlags) {
        throw new UsageError("config set accepts either a key and value or flags, not both");
      }
      if (key && !(key in CONFIG_KEYS)) {
        throw new UsageError(`unknown config key: ${key}`);
      }
      if (key && key in CONFIG_KEYS && !hasFlags && !positionals[3]) {
        throw new UsageError(`config set ${key} requires a value`);
      }
    }
  }

  if (command === "call") {
    const methodRaw = positionals[1];
    const path = positionals[2];
    if (methodRaw === undefined || path === undefined) {
      throw new UsageError("call requires <METHOD> <PATH>");
    }
    const method = methodRaw.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new UsageError(`unsupported method: ${methodRaw}`);
    }
    if (flags.has("data")) {
      if (method === "GET" || method === "HEAD") {
        throw new UsageError(`${method} does not accept --data`);
      }
      try {
        call = { method, path, body: JSON.parse(flags.get("data")) };
      } catch {
        throw new UsageError("--data must be valid JSON");
      }
    } else {
      call = { method, path, body: undefined };
    }
  }

  return { call };
}

async function resolveSettings(flags, deps) {
  const overrides = {};
  if (flags.has("base-url")) overrides.baseUrl = flags.get("base-url");
  if (flags.has("timeout")) overrides.timeoutMs = flags.get("timeout");
  if (flags.has("event-timeout")) overrides.eventTimeoutMs = flags.get("event-timeout");
  if (flags.has("agent")) overrides.agent = flags.get("agent");
  if (flags.has("mode")) overrides.mode = flags.get("mode");
  // Apply overrides before validation so an invalid lower-priority environment
  // value cannot block a valid flag.
  const config = await loadConfig({
    env: deps.env,
    ...(deps.configDeps ?? {}),
    overrides,
  });

  const baseUrl = config.baseUrl;
  const token = flags.has("token") ? flags.get("token") : config.token;
  const timeoutMs = config.timeoutMs;

  // `config` commands must work on a fresh install, so the base URL is only
  // required by the commands that actually send requests.
  return {
    ...config,
    baseUrl,
    token: token || null,
    timeoutMs,
    eventTimeoutMs: config.eventTimeoutMs,
    model: flags.has("model") ? flags.get("model") : config.model,
    agent: config.agent,
    mode: config.mode,
    endpoint: flags.has("endpoint") ? flags.get("endpoint") : config.endpoint,
    chatPath: flags.has("chat-path") ? flags.get("chat-path") : config.chatPath,
  };
}

function requireBaseUrl(context) {
  if (!context.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no engine configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  return context;
}

async function commandOpenapi(context, deps, write, flags) {
  const discovery = await discoverOpenApi({ ...context, fetchImpl: deps.fetchImpl });
  const displayOperations = discovery.operations.map((operation) => ({
    ...operation,
    path: redact(operation.path, context.token),
    operationId: operation.operationId ? redact(operation.operationId, context.token) : null,
    summary: operation.summary ? redact(operation.summary, context.token) : null,
  }));
  const lines = displayOperations
    .slice(0, 50)
    .map((operation) => `  ${operation.method.padEnd(6)} ${operation.path}${operation.operationId ? `  # ${operation.operationId}` : ""}`);
  emit(
    write,
    flags,
    `contract: ${discovery.sourcePath} (${displayOperations.length} operations)\n${lines.join("\n")}\n`,
    {
      sourcePath: discovery.sourcePath,
      operationCount: displayOperations.length,
      operations: displayOperations,
    },
  );
}

async function commandCall(call, context, deps, write, flags) {
  const { method, path, body } = call;
  const response = await request({ ...context, path, method, body, fetchImpl: deps.fetchImpl });
  const payload = responseBody(response);
  const displayPath = redact(path, context.token);

  emit(
    write,
    flags,
    `${method} ${displayPath} -> ${response.status}\n${response.json !== null ? formatJson(response.json) : response.text}\n`,
    { method, path: displayPath, status: response.status, body: payload },
  );
}

async function commandConfig(positionals, context, deps, write, flags) {
  const action = positionals[1] ?? "show";

  if (action === "show" || action === "list") {
    const described = describeConfig(context);
    emit(
      write,
      flags,
      `config: ${described.configPath}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\ntimeout: ${described.timeoutMs}ms\nevent timeout: ${described.eventTimeoutMs}ms\nagent: ${described.agent || "(engine default)"}\nmode: ${described.mode || "(engine default)"}\nmodel: ${described.model || "(not set)"}\n`,
      described,
    );
    return;
  }

  if (action === "get") {
    const key = positionals[2];
    if (!key || !(key in CONFIG_KEYS)) {
      throw new UsageError(`config get requires one of: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    }
    const value = context[CONFIG_KEYS[key]];
    write(flags.has("json") ? formatJson({ [key]: value }) : String(value || "(unset)"));
    return;
  }

  if (action !== "set") {
    throw new UsageError(`unknown config action: ${action}`);
  }

  const patch = {};
  const key = positionals[2];
  const hasFlags = CONFIG_FLAGS.some((name) => flags.has(name));
  if (key && key in CONFIG_KEYS && !hasFlags) {
    const value = positionals.slice(3).join(" ").trim();
    if (!value) throw new UsageError(`config set ${key} requires a value`);
    patch[CONFIG_KEYS[key]] = value;
  } else {
    if (flags.has("base-url")) patch.baseUrl = flags.get("base-url");
    if (flags.has("token")) patch.token = flags.get("token");
    if (flags.has("chat-path")) patch.chatPath = flags.get("chat-path");
    if (flags.has("endpoint")) patch.endpoint = flags.get("endpoint");
    if (flags.has("model")) patch.model = flags.get("model");
    if (flags.has("agent")) patch.agent = flags.get("agent");
    if (flags.has("mode")) patch.mode = flags.get("mode");
    if (flags.has("timeout")) {
      const timeoutMs = Number(flags.get("timeout"));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
        throw new UsageError("--timeout must be an integer between 100 and 120000");
      }
      patch.timeoutMs = timeoutMs;
    }
    if (flags.has("event-timeout")) patch.eventTimeoutMs = flags.get("event-timeout");
  }
  if (Object.keys(patch).length === 0) {
    throw new UsageError("config set requires a key and value, or --base-url/--token/--timeout");
  }
  if (patch.agent !== undefined && !KNOWN_AGENTS.includes(patch.agent)) {
    throw new UsageError(`agent must be one of: ${KNOWN_AGENTS.join(", ")}`);
  }
  if (patch.mode !== undefined && !DATA_MODES.includes(patch.mode)) {
    throw new UsageError(`mode must be one of: ${DATA_MODES.join(", ")}`);
  }
  if (patch.eventTimeoutMs !== undefined) {
    const eventTimeoutMs = Number(patch.eventTimeoutMs);
    if (!Number.isInteger(eventTimeoutMs) || eventTimeoutMs < 1000 || eventTimeoutMs > 600000) {
      throw new UsageError("event timeout must be an integer between 1000 and 600000");
    }
    patch.eventTimeoutMs = eventTimeoutMs;
  }

  const saved = await saveConfig(patch, {
    ...(deps.saveDeps ?? {}),
    filePath: context.configPath,
  });
  const described = describeConfig(
    await loadConfig({ env: deps.env, filePath: saved.path }),
  );

  emit(write, flags, `wrote ${saved.path}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\n`, described);
}

function exitFor(error) {
  if (
    error instanceof UsageError
    || error instanceof ConfigError
    || error.code === "USAGE"
    || error.code === "validation_failed"
  ) {
    return EXIT.usage;
  }
  if (error.code === "UNAVAILABLE" || error.code === "engine_unavailable" || error.code === "not_ready") {
    return EXIT.unavailable;
  }
  if (error.code === "CANCELLED" || error.code === "cancelled") return EXIT.cancelled;
  if (error.code === "unauthorized" || error.code === "forbidden" || error.code === "HTTP_401" || error.code === "HTTP_403") {
    return EXIT.unauthenticated;
  }
  if (error.code === "not_found" || error.code === "HTTP_404") return EXIT.notFound;
  if (
    error.code === "REQUEST_TIMEOUT"
    || error.code === "REQUEST_FAILED"
    || error.code === "STREAM_DISCONNECTED"
  ) {
    return EXIT.network;
  }
  return EXIT.failure;
}

export async function runCli(argv, options = {}) {
  const deps = {
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? fetch,
    stdout: options.stdout ?? ((text) => process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => process.stderr.write(text)),
    configDeps: options.configDeps,
    saveDeps: options.saveDeps,
    signal: options.signal,
    stdinIsTTY: options.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    readSecret: options.readSecret ?? readStdin,
  };

  // Every command output passes through the same token redaction, including
  // engine responses and streamed text. The token is normally absent from those
  // bodies, but a deployment must not be able to echo it back into a log.
  let outputToken = null;
  const safe = (text) => redact(String(text), outputToken);
  const write = (text) => {
    const value = safe(text);
    deps.stdout(value.endsWith("\n") ? value : `${value}\n`);
  };
  const raw = (text) => deps.stdout(safe(text));

  try {
    const { flags, positionals } = parseArgv(argv);

    if (flags.has("help")) {
      deps.stdout(USAGE);
      return EXIT.ok;
    }
    if (flags.has("version")) {
      write(`coderax-cli ${VERSION}`);
      return EXIT.ok;
    }
    if (positionals.length === 0) {
      deps.stdout(USAGE);
      return EXIT.ok;
    }

    const { call } = preflight(positionals, flags);

    const settings = await resolveSettings(flags, deps);
    outputToken = settings.token;
    const [command] = positionals;
    const ctx = {
      ...settings,
      settings,
      args: positionals.slice(1),
      flags,
      env: deps.env,
      json: flags.has("json"),
      out: write,
      raw,
      err: (text) => deps.stderr(`${redact(String(text), settings.token)}\n`),
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
      stdinIsTTY: deps.stdinIsTTY,
      readSecret: deps.readSecret,
    };

    if (command === "config") {
      await commandConfig(positionals, settings, deps, write, flags);
      return EXIT.ok;
    }

    switch (command) {
      case "login":
        return await engine.login(ctx);
      case "logout":
        return await engine.logout(ctx);
      case "status":
        return await engine.status(ctx);
      case "health":
        return await engine.health(ctx);
      case "ready":
        return await engine.ready(ctx);
      case "doctor":
        return await engine.doctor(ctx);
      case "capabilities":
      case "caps":
        return await engine.capabilities(ctx);
      case "agents":
        return await engine.agents(ctx);
      case "models":
        return await engine.models(ctx);
      case "chat":
        return await engine.chat(ctx);
      case "work":
        return await engine.work(ctx);
      case "task":
        return await engine.task(ctx);
      case "tasks":
        return await engine.tasks(ctx);
      case "events":
        return await engine.events(ctx);
      case "cancel":
        return await engine.cancel(ctx);
      case "resume":
        return await engine.resume(ctx);
      case "retry":
        return await engine.retry(ctx);
      case "permissions":
        return await engine.permissions(ctx);
      case "approve":
        return await engine.approve(ctx);
      case "deny":
        return await engine.deny(ctx);
      case "notifications":
        return await engine.notifications(ctx);
      case "conversations":
        return await engine.conversations(ctx);
      case "conversation":
        return await engine.conversation(ctx);
      case "memory":
        return await engine.memory(ctx);
      case "artifacts":
        return await engine.artifacts(ctx);
      case "products":
        return await product.products(ctx);
      case "cloud":
        return await product.cloud(ctx);
      case "projects":
        return await product.projects(ctx);
      case "update":
        return await product.update(ctx);
      case "help":
        deps.stdout(USAGE);
        return EXIT.ok;
      case "version":
        write(`coderax-cli ${VERSION}`);
        return EXIT.ok;
      default:
        break;
    }

    const context = requireBaseUrl(settings);

    switch (command) {
      case "openapi":
        await commandOpenapi(context, deps, write, flags);
        return EXIT.ok;
      case "call":
        await commandCall(call, context, deps, write, flags);
        return EXIT.ok;
      default:
        throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
    }
  } catch (error) {
    const known = error instanceof UsageError || error instanceof ConfigError || error instanceof CoderaxError;
    const detail =
      error instanceof UsageError ? error.message : `${error.code ?? "ERROR"}: ${error.message}`;
    deps.stderr(`coderax: ${redact(known ? detail : "unexpected failure", outputToken)}\n`);
    return exitFor(error);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

export function isEntrypoint(entry = process.argv[1]) {
  if (entry === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    // npm exposes package executables as symlinks on POSIX; compare real paths.
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return entry === modulePath;
  }
}

if (isEntrypoint()) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
