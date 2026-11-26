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
import { discoverOpenApi, findOperation } from "./discover.js";
import * as product from "./product-commands.js";
import { VERSION } from "./version.js";

export { VERSION };

const USAGE = `coderax ${VERSION} - command-line client for a Coderax deployment

Usage:
  coderax products [--json]
  coderax chat [message] [--model <id>] [--json]
  coderax work [message] [--model <id>] [--json]
  coderax models [--json]
  coderax agents [--json]
  coderax cloud [--json]
  coderax projects [--json]
  coderax login [--token <token>] [--json]
  coderax logout [--json]
  coderax status [--json]
  coderax config show|list [--json]
  coderax config get <key>
  coderax config set <key> <value>
  coderax config set [--base-url <url>] [--token <token>] [--timeout <ms>]
  coderax doctor [--json]
  coderax update [--json]
  coderax health [--json]
  coderax openapi [--json]
  coderax call <METHOD> <PATH> [--data <json>] [--json]
  coderax help
  coderax version

Global options:
  --base-url <url>   Override the deployment URL (HTTPS, or HTTP on loopback)
  --token <token>    Override the configured bearer token
  --timeout <ms>     Per-request timeout, 100-120000
  --model <id>       Override the model for one invocation
  --endpoint <name>  Override the chat endpoint name
  --chat-path <path> Override the streaming path
  --url <path>       Override the streaming path for one invocation
  --json             Machine-readable output
  --no-color         Accepted for compatibility
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  CODERAX_BASE_URL, CODERAX_TOKEN, CODERAX_TIMEOUT_MS, CODERAX_CONFIG,
  CODERAX_CONFIG_DIR, CODERAX_CHAT_PATH, CODERAX_ENDPOINT, CODERAX_MODEL

Discovery: agents, models, and openapi use the deployment's OpenAPI document.
health probes fixed paths, login checks /api/user, doctor probes the same health
endpoints, and chat and work use the configured chat path. call uses the path you supply.
A missing discovered route fails with OPERATION_NOT_FOUND.
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
}));
const CONFIG_FLAGS = ["base-url", "token", "timeout", "chat-path", "endpoint", "model"];

const KNOWN_COMMANDS = new Set([
  "config",
  "health",
  "openapi",
  "agents",
  "models",
  "call",
  "products",
  "chat",
  "work",
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
  "data",
  "model",
  "endpoint",
  "chat-path",
  "url",
  "no-color",
]);
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
    model: flags.has("model") ? flags.get("model") : config.model,
    endpoint: flags.has("endpoint") ? flags.get("endpoint") : config.endpoint,
    chatPath: flags.has("chat-path") ? flags.get("chat-path") : config.chatPath,
  };
}

function requireBaseUrl(context) {
  if (!context.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  return context;
}

async function commandHealth(context, deps, write, flags) {
  const { path, response } = await product.probeHealth({ ...context, fetchImpl: deps.fetchImpl });
  const body = responseBody(response);
  emit(
    write,
    flags,
    `health: ok (GET ${path}) HTTP ${response.status}\n${response.json ? formatJson(response.json) : ""}`,
    { endpoint: path, status: response.status, body },
  );
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

async function commandResource(kind, context, deps, write, flags) {
  const discovery = await discoverOpenApi({ ...context, fetchImpl: deps.fetchImpl });
  const matcher = kind === "agents" ? /\/agents\/?$/i : /\/models\/?$/i;
  const operation = findOperation(discovery.operations, matcher);

  if (operation === null) {
    throw new CoderaxError(
      "OPERATION_NOT_FOUND",
      `the deployment's OpenAPI document has no GET ${kind} operation; run \`coderax openapi\` to list available paths`,
    );
  }

  const response = await request({
    ...context,
    path: operation.path,
    fetchImpl: deps.fetchImpl,
  });
  const payload = responseBody(response);
  const displayPath = redact(operation.path, context.token);

  emit(
    write,
    flags,
    `${operation.method} ${displayPath} -> ${response.status}\n${response.json ? formatJson(response.json) : response.text}\n`,
    { method: operation.method, path: displayPath, status: response.status, body: payload },
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
      `config: ${described.configPath}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\ntimeout: ${described.timeoutMs}ms\nchat path: ${described.chatPath}\nendpoint: ${described.endpoint}\nmodel: ${described.model || "(not set)"}\n`,
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
    if (flags.has("timeout")) {
      const timeoutMs = Number(flags.get("timeout"));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
        throw new UsageError("--timeout must be an integer between 100 and 120000");
      }
      patch.timeoutMs = timeoutMs;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new UsageError("config set requires a key and value, or --base-url/--token/--timeout");
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
  if (error instanceof UsageError || error instanceof ConfigError || error.code === "USAGE") {
    return EXIT.usage;
  }
  if (error.code === "UNAVAILABLE") return EXIT.unavailable;
  if (error.code === "CANCELLED") return EXIT.cancelled;
  if (error.code === "HTTP_401" || error.code === "HTTP_403") return EXIT.unauthenticated;
  if (error.code === "HTTP_404") return EXIT.notFound;
  if (
    error.code === "REQUEST_TIMEOUT"
    || error.code === "REQUEST_FAILED"
    || error.code === "STREAM_INCOMPLETE"
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

  const write = (text) => deps.stdout(text.endsWith("\n") ? text : `${text}\n`);
  const raw = (text) => deps.stdout(String(text));

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
      err: (text) => deps.stderr(`${text}\n`),
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
      case "products":
        return await product.products(ctx);
      case "cloud":
        return await product.cloud(ctx);
      case "projects":
        return await product.projects(ctx);
      case "status":
        return await product.status(ctx);
      case "login":
        return await product.login(ctx);
      case "logout":
        return await product.logout(ctx);
      case "chat":
        return await product.chat(ctx);
      case "work":
        return await product.work(ctx);
      case "doctor":
        return await product.doctor(ctx);
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
      case "health":
        await commandHealth(context, deps, write, flags);
        return EXIT.ok;
      case "openapi":
        await commandOpenapi(context, deps, write, flags);
        return EXIT.ok;
      case "agents":
      case "models":
        await commandResource(command, context, deps, write, flags);
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
    deps.stderr(`coderax: ${known ? detail : "unexpected failure"}\n`);
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
  // Cancellation has to reach the stream, not kill the process before the
  // partial answer is accounted for. A second signal, or a request that never
  // settles, still exits 130 instead of hanging a pipeline.
  const controller = new AbortController();
  let forced;
  const cancel = () => {
    controller.abort();
    forced = setTimeout(() => process.exit(EXIT.cancelled), 2000);
    forced.unref?.();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
  } finally {
    clearTimeout(forced);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
