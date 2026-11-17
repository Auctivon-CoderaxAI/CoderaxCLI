#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  normalizeBaseUrl,
  saveConfig,
} from "./config.js";
import { CoderaxError, formatJson, request } from "./client.js";
import { discoverOpenApi, findOperation } from "./discover.js";

export const VERSION = "0.1.0";

const USAGE = `coderax ${VERSION} - command-line client for a Coderax deployment

Usage:
  coderax config show [--json]
  coderax config set [--base-url <url>] [--token <token>] [--timeout <ms>]
  coderax health [--json]
  coderax openapi [--json]
  coderax agents [--json]
  coderax models [--json]
  coderax call <METHOD> <PATH> [--data <json>] [--json]

Global options:
  --base-url <url>   Override the deployment URL (HTTPS, or HTTP on loopback)
  --token <token>    Override the configured bearer token
  --timeout <ms>     Per-request timeout, 100-120000
  --json             Machine-readable output
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  CODERAX_BASE_URL, CODERAX_TOKEN, CODERAX_TIMEOUT_MS, CODERAX_CONFIG

API paths are resolved from the deployment's own OpenAPI document. The CLI does
not hardcode routes and fails with OPERATION_NOT_FOUND when a route is absent.
`;

const EXIT = Object.freeze({ ok: 0, failure: 1, usage: 2 });

const KNOWN_COMMANDS = new Set(["config", "health", "openapi", "agents", "models", "call"]);
const KNOWN_FLAGS = new Set(["help", "version", "json", "base-url", "token", "timeout", "data"]);
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

/**
 * Validate everything that does not need configuration before touching the
 * config file, so a typo reports a usage error instead of a missing base URL.
 */
function preflight(positionals, flags) {
  const [command] = positionals;

  if (!KNOWN_COMMANDS.has(command)) {
    throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
  }

  if (command === "config") {
    const action = positionals[1] ?? "show";
    if (action !== "show" && action !== "set") {
      throw new UsageError(`unknown config action: ${action}`);
    }
    if (action === "set" && !["base-url", "token", "timeout"].some((name) => flags.has(name))) {
      throw new UsageError("config set requires --base-url, --token, or --timeout");
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
        JSON.parse(flags.get("data"));
      } catch {
        throw new UsageError("--data must be valid JSON");
      }
    }
  }
}

async function resolveSettings(flags, deps) {
  const config = await loadConfig({ env: deps.env, ...(deps.configDeps ?? {}) });

  let baseUrl = config.baseUrl;
  if (flags.has("base-url")) baseUrl = normalizeBaseUrl(flags.get("base-url")).baseUrl;

  const token = flags.has("token") ? flags.get("token") : config.token;

  let timeoutMs = config.timeoutMs;
  if (flags.has("timeout")) {
    timeoutMs = Number(flags.get("timeout"));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      throw new UsageError("--timeout must be an integer between 100 and 120000");
    }
  }

  // `config` commands must work on a fresh install, so the base URL is only
  // required by the commands that actually send requests.
  return { config, baseUrl, token: token || null, timeoutMs };
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
  const candidates = ["/health", "/api/health", "/healthz"];
  const attempts = [];

  for (const path of candidates) {
    try {
      const response = await request({ ...context, path, fetchImpl: deps.fetchImpl });
      const body = response.json ?? response.text;
      emit(
        write,
        flags,
        `health: ok (GET ${path}) HTTP ${response.status}\n${response.json ? formatJson(response.json) : ""}`,
        { endpoint: path, status: response.status, body },
      );
      return;
    } catch (error) {
      attempts.push({ endpoint: path, code: error.code ?? "ERROR" });
      if (error.code === "HTTP_404" || error.code === "HTTP_405") continue;
      throw error;
    }
  }

  throw new CoderaxError(
    "HEALTH_UNAVAILABLE",
    `no health endpoint responded. Tried ${attempts.map((entry) => `${entry.endpoint} (${entry.code})`).join(", ")}`,
  );
}

async function commandOpenapi(context, deps, write, flags) {
  const discovery = await discoverOpenApi({ ...context, fetchImpl: deps.fetchImpl });
  const lines = discovery.operations
    .slice(0, 50)
    .map((operation) => `  ${operation.method.padEnd(6)} ${operation.path}${operation.operationId ? `  # ${operation.operationId}` : ""}`);
  emit(
    write,
    flags,
    `contract: ${discovery.sourcePath} (${discovery.operations.length} operations)\n${lines.join("\n")}\n`,
    {
      sourcePath: discovery.sourcePath,
      operationCount: discovery.operations.length,
      operations: discovery.operations,
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
  const payload = response.json ?? response.text;

  emit(
    write,
    flags,
    `${operation.method} ${operation.path} -> ${response.status}\n${response.json ? formatJson(response.json) : response.text}\n`,
    { method: operation.method, path: operation.path, status: response.status, body: payload },
  );
}

async function commandCall(positionals, context, deps, write, flags) {
  const methodRaw = positionals[1];
  const path = positionals[2];

  if (methodRaw === undefined || path === undefined) {
    throw new UsageError("call requires <METHOD> <PATH>");
  }

  const method = methodRaw.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    throw new UsageError(`unsupported method: ${methodRaw}`);
  }

  let body;
  if (flags.has("data")) {
    if (method === "GET" || method === "HEAD") {
      throw new UsageError(`${method} does not accept --data`);
    }
    try {
      body = JSON.parse(flags.get("data"));
    } catch {
      throw new UsageError("--data must be valid JSON");
    }
  }

  const response = await request({ ...context, path, method, body, fetchImpl: deps.fetchImpl });
  const payload = response.json ?? response.text;

  emit(
    write,
    flags,
    `${method} ${path} -> ${response.status}\n${response.json ? formatJson(response.json) : response.text}\n`,
    { method, path, status: response.status, body: payload },
  );
}

async function commandConfig(positionals, context, deps, write, flags) {
  const action = positionals[1] ?? "show";

  if (action === "show") {
    const described = describeConfig(context.config);
    emit(
      write,
      flags,
      `config: ${described.configPath}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\ntimeout: ${described.timeoutMs}ms\n`,
      described,
    );
    return;
  }

  if (action !== "set") {
    throw new UsageError(`unknown config action: ${action}`);
  }

  const patch = {};
  if (flags.has("base-url")) patch.baseUrl = flags.get("base-url");
  if (flags.has("token")) patch.token = flags.get("token");
  if (flags.has("timeout")) {
    const timeoutMs = Number(flags.get("timeout"));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      throw new UsageError("--timeout must be an integer between 100 and 120000");
    }
    patch.timeoutMs = timeoutMs;
  }
  if (Object.keys(patch).length === 0) {
    throw new UsageError("config set requires --base-url, --token, or --timeout");
  }

  const saved = await saveConfig(patch, {
    ...(deps.saveDeps ?? {}),
    filePath: context.config.configPath,
  });
  const described = describeConfig(
    await loadConfig({ env: deps.env, filePath: saved.path }),
  );

  emit(write, flags, `wrote ${saved.path}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\n`, described);
}

export async function runCli(argv, options = {}) {
  const deps = {
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? fetch,
    stdout: options.stdout ?? ((text) => process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => process.stderr.write(text)),
    configDeps: options.configDeps,
    saveDeps: options.saveDeps,
  };

  const write = (text) => deps.stdout(text.endsWith("\n") ? text : `${text}\n`);

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

    preflight(positionals, flags);

    const settings = await resolveSettings(flags, deps);
    const [command] = positionals;

    if (command === "config") {
      await commandConfig(positionals, settings, deps, write, flags);
      return EXIT.ok;
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
        await commandCall(positionals, context, deps, write, flags);
        return EXIT.ok;
      default:
        throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
    }
  } catch (error) {
    const known = error instanceof UsageError || error instanceof ConfigError || error instanceof CoderaxError;
    const detail =
      error instanceof UsageError ? error.message : `${error.code ?? "ERROR"}: ${error.message}`;
    deps.stderr(`coderax: ${known ? detail : "unexpected failure"}\n`);
    if (error instanceof UsageError || error instanceof ConfigError) return EXIT.usage;
    return EXIT.failure;
  }
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
  process.exitCode = await runCli(process.argv.slice(2));
}
