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
import * as capabilities from "./capability-commands.js";
import {
  ARTIFACT_ACTIONS,
  CAPABILITY_COMMANDS,
  SCHEDULE_ACTIONS,
  capabilityFamilyFor,
  isCapabilityCommand,
  isExtendedCommand,
} from "./capability-catalog.js";
import { SHELLS, completionScript } from "./completion.js";
import { createCredentialStore } from "./credentials.js";
import { resolveSessionToken } from "./auth.js";
import { interactiveHelp, runInteractive } from "./interactive.js";
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
  coderax login [--token-file <path> | --with-token] [--json]
  coderax logout [--json]
  coderax status [--json]
  coderax config show|list [--json]
  coderax config get <key>
  coderax config set <key> <value>
  coderax config set [--base-url <url>] [--token <token>] [--timeout <ms>]
  coderax doctor [--json]
  coderax update [--json]
  coderax health [--json]
  coderax interactive [--mode chat|work]
  coderax openapi [--json]
  coderax call <METHOD> <PATH> [--data <json>] [--json]

Capabilities (availability comes from the engine handshake; only an available
capability executes, and nothing is simulated locally):
  coderax capabilities [--status <state>] [--json]
  coderax readiness [--json]
  coderax capability run <id|command> [options] [--json]
  coderax upload <file> --task <taskId> [--json]
  coderax analyze-document <file> [--question <text>] [--json]
  coderax create-document <prompt> [--format md|txt|docx|pdf] [--json]
  coderax analyze-pdf <file> [--question <text>] [--json]
  coderax create-pdf <prompt> [--name <name>] [--json]
  coderax analyze-spreadsheet <file> [--question <text>] [--json]
  coderax create-spreadsheet <prompt> [--format xlsx|csv] [--json]
  coderax create-presentation <prompt> [--format pptx|pdf] [--file <path>] [--json]
  coderax analyze-data <prompt> [--file <path>] [--question <text>] [--json]
  coderax visualize-data <prompt> [--file <path>] [--chart bar|line|area|scatter|pie] [--json]
  coderax understand-image <file> [--question <text>] [--json]
  coderax generate-image <prompt> [--size <size>] [--count <n>] [--json]
  coderax edit-image <file> [--instruction <text>] [--json]
  coderax transcribe <file> [--language <code>] [--format txt|srt|vtt] [--json]
  coderax speak <text> [--voice <id>] [--format mp3|wav|opus] [--json]
  coderax understand-video <file> [--question <text>] [--json]
  coderax create-software <prompt> [--name <name>] [--json]
  coderax create-game <prompt> [--name <name>] [--json]
  coderax gaming-agent <objective> [--session <id>] [--json]
  coderax orchestrate <prompt> [--agent <id>] [--json]
  coderax artifacts list --task <id> [--json]
  coderax artifacts inspect <artifactId> --task <id> [--json]
  coderax artifacts download <artifactId> --task <id> [--out <path>] [--force] [--json]
  coderax schedules list|create|pause|resume|delete ... [--json]
  coderax permissions list --task <id> | approve|deny <taskId> <requestId> [--json]
  coderax task <taskId> [--json]
  coderax completion bash|zsh|fish

Capability execution options:
  --task <taskId>       Owner task that owns an uploaded or listed artifact
  --file <path>         Optional source file for a capability
  --question <text>     Question to answer about an attached file
  --conversation <id>   Run in an existing conversation
  --agent <id>          coderax, opencode or freebuff
  --wait / --no-wait    Wait for the durable task (default) or return its id
  --stream              Write each execution event to stderr as JSON
  --wait-timeout <ms>   Wait limit, 1000-3600000 (default 600000)
  --out <path>          Explicit download destination for the first artifact
  --force               Authorize replacing an existing download destination

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
  contract: 7,
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
  "capabilities",
  "readiness",
  "capability",
  "artifacts",
  "schedules",
  "permissions",
  "task",
  "completion",
  "interactive",
  ...CAPABILITY_COMMANDS,
]);

const COMMAND_ALIASES = Object.freeze({
  caps: "capabilities",
  stt: "transcribe",
  tts: "speak",
  tui: "interactive",
});
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
  "token-file",
  "with-token",
  "mode",
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
  const dynamic = new Map();
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
        // Capability and artifact options are published by the engine registry,
        // so they cannot be known while parsing. They are collected here and
        // rejected by preflight when the command does not accept them.
        if (equals !== -1) {
          dynamic.set(name, body.slice(equals + 1));
          continue;
        }
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          dynamic.set(name, next);
          index += 1;
        } else {
          dynamic.set(name, true);
        }
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

  return { flags, positionals, dynamic };
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
function preflight(positionals, flags, dynamic) {
  const rawCommand = positionals[0];
  const command = COMMAND_ALIASES[rawCommand] ?? rawCommand;
  if (command !== rawCommand) positionals[0] = command;
  let call = null;

  if (!KNOWN_COMMANDS.has(command)) {
    throw new UsageError(`unknown command: ${rawCommand}. Run \`coderax --help\`.`);
  }

  if (dynamic.size > 0 && !isExtendedCommand(command)) {
    throw new UsageError(`unknown option: --${[...dynamic.keys()][0]}`);
  }

  if (command === "capability") {
    const action = positionals[1];
    if (action !== "run") {
      throw new UsageError("capability requires: coderax capability run <id|command> [options]");
    }
    if (!positionals[2]) {
      throw new UsageError("capability run requires a capability id or command");
    }
  }

  if (command === "artifacts") {
    const action = positionals[1] ?? "list";
    if (!ARTIFACT_ACTIONS.includes(action)) {
      throw new UsageError(`unknown artifacts action: ${action}. Use ${ARTIFACT_ACTIONS.join(", ")}`);
    }
    if (action === "list" && !positionals[2] && !dynamic.has("task")) {
      throw new UsageError("artifacts list requires --task <taskId>");
    }
    if (action === "inspect" || action === "download") {
      if (!positionals[2]) throw new UsageError(`artifacts ${action} requires an artifact id`);
      if (!dynamic.has("task")) {
        throw new UsageError(`artifacts ${action} requires --task <taskId> (contract 1.1.0 is task-scoped)`);
      }
    }
  }

  if (command === "schedules") {
    const action = positionals[1] ?? "list";
    if (!SCHEDULE_ACTIONS.includes(action)) {
      throw new UsageError(`unknown schedules action: ${action}. Use ${SCHEDULE_ACTIONS.join(", ")}`);
    }
    if (action === "create" && !positionals[2]) {
      throw new UsageError("schedules create requires an objective");
    }
    if ((action === "pause" || action === "resume" || action === "delete") && !positionals[2]) {
      throw new UsageError(`schedules ${action} requires a schedule id`);
    }
  }

  if (command === "permissions") {
    const action = positionals[1] ?? "list";
    if (!["list", "approve", "deny"].includes(action)) {
      throw new UsageError("permissions requires list, approve or deny");
    }
    if (action === "list" && !positionals[2] && !dynamic.has("task")) {
      throw new UsageError("permissions list requires --task <taskId> (contract 1.1.0 is task-scoped)");
    }
    if (action !== "list" && (!positionals[2] || !positionals[3])) {
      throw new UsageError(`permissions ${action} requires <taskId> <requestId>`);
    }
  }

  if (command === "task" && !positionals[1]) {
    throw new UsageError("task requires a task id");
  }

  if (command === "login") {
    if (flags.has("token-file") && flags.has("with-token")) {
      throw new UsageError("login accepts either --token-file or --with-token, not both");
    }
    if (positionals.length > 1) {
      throw new UsageError("login accepts no positional arguments; pipe the token to `coderax login --with-token`");
    }
  }
  if ((flags.has("token-file") || flags.has("with-token")) && command !== "login") {
    throw new UsageError("--token-file and --with-token are only valid with `coderax login`");
  }

  if (command === "interactive") {
    if (positionals.length > 1) throw new UsageError("interactive takes no positional arguments");
    if (flags.has("json")) throw new UsageError("interactive does not support --json");
    if (flags.has("mode") && !["chat", "work"].includes(flags.get("mode"))) {
      throw new UsageError("--mode must be chat or work");
    }
  }

  if (command === "completion") {
    const shell = positionals[1];
    if (shell === undefined) {
      throw new UsageError(`completion requires a shell: ${SHELLS.join(", ")}`);
    }
    if (!SHELLS.includes(shell)) {
      throw new UsageError(`unsupported shell: ${shell}. Use ${SHELLS.join(", ")}`);
    }
  }

  if ((command === "capabilities" || command === "readiness") && positionals.length > 1) {
    throw new UsageError(`${command} takes no positional arguments`);
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

function commandHelp(command) {
  if (command === "artifacts") {
    return `coderax artifacts <action>\n\nUsage:\n  coderax artifacts list --task <taskId> [--json]\n  coderax artifacts inspect <artifactId> --task <taskId> [--json]\n  coderax artifacts download <artifactId> --task <taskId> [--out <path>] [--force] [--json]\n\nArtifacts are owner-scoped records of the authoritative engine artifact\nservice (GET/POST /v1/work/{taskId}/artifacts,\nGET /v1/work/{taskId}/artifacts/{artifactId}). Contract 1.1.0 is task-scoped,\nso every read names the task that owns the bytes. A download is verified\nagainst the engine-computed sha256 digest and is never written over an\nexisting file without --force.`;
  }
  if (command === "schedules") {
    return `coderax schedules <action>\n\nUsage:\n  coderax schedules list [--json]\n  coderax schedules create <objective> --interval-ms <ms> [--start-at <ISO-8601>] [--agent <id>] [--json]\n  coderax schedules pause <scheduleId> [--json]\n  coderax schedules resume <scheduleId> [--json]\n  coderax schedules delete <scheduleId> [--json]\n\nSchedules are durable on the engine (POST /v1/schedules); closing the terminal\ndoes not cancel them. The minimum interval is 60000 ms. Each schedule reports\nits run and skipped counts, last task and next run; contract 1.1.0 publishes no\nseparate execution-history route, so the CLI does not invent one.`;
  }
  if (command === "permissions") {
    return `coderax permissions <action>\n\nUsage:\n  coderax permissions list --task <taskId> [--json]\n  coderax permissions approve <taskId> <requestId> [--reason <text>] [--json]\n  coderax permissions deny <taskId> <requestId> [--reason <text>] [--json]\n\nOnly the engine can approve a scoped request; the CLI forwards the owner's\ndecision and never widens a grant. Contract 1.1.0 addresses permission requests\nby task, so a listing names the task it belongs to.`;
  }
  if (command === "interactive") {
    return `coderax interactive [--mode chat|work]\n\n${interactiveHelp()}`;
  }
  if (command === "task") {
    return `coderax task <taskId> [--json]\n\nReattaches to a durable task through GET /v1/work/{taskId} and lists the\nartifacts it produced. It does not resubmit anything.`;
  }
  if (command === "capabilities" || command === "readiness") {
    return `coderax ${command}\n\nReads GET /v1/handshake, the authoritative list of contract version,\ncapability states and implemented operations, and reports each command as\navailable, unconfigured, unverified, unavailable, blocked or not_implemented.\nOnly an available capability executes; nothing is simulated locally.`;
  }
  const entry = capabilityFamilyFor(command);
  if (entry === null) return null;
  const attachment = entry.attachment
    ? (entry.attachment.required ? " <file>" : " [--file <path>]")
    : "";
  const prompt = entry.mode === "upload" ? "" : (entry.attachment?.required ? " [<request>]" : " <request>");
  const options = (entry.options ?? [])
    .map((option) => `[--${option.flag} <${option.values ? option.values.join("|") : option.label}>]`)
    .join(" ");
  return `coderax ${entry.command}${attachment}${prompt}${options ? ` ${options}` : ""} [--out <path>] [--json]\n\n${entry.summary}\n\nAvailability comes from the engine handshake (requires ${entry.requires.join(", ")});\nrun \`coderax capabilities\` for the live status. The request runs as an\nauthorized cloud Work task (POST /v1/work); no document, inference, generation\nor execution happens on this machine.`;
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
  const timeoutMs = config.timeoutMs;
  const credentialStore = deps.credentialStore ?? createCredentialStore({
    env: deps.env,
    ...(deps.platform ? { platform: deps.platform } : {}),
  });

  let session;
  let authError = null;
  try {
    session = await resolveSessionToken({
      config,
      env: deps.env,
      flagToken: flags.get("token"),
      store: credentialStore,
    });
  } catch (error) {
    // A locked or unreadable credential store must not prevent local-only
    // commands such as `config show`; the error is reported by `status`.
    authError = error?.message ?? String(error);
    session = { token: null, source: "unavailable", legacy: false, account: null };
  }
  if (session.legacy) {
    deps.stderr(
      "coderax: warning: a legacy plaintext token is present in the config file; "
        + "run `coderax login --with-token` to move it into the operating-system credential store\n",
    );
  }

  // `config` commands must work on a fresh install, so the base URL is only
  // required by the commands that actually send requests.
  return {
    ...config,
    baseUrl,
    token: session.token || null,
    tokenSource: session.source,
    authError,
    credentialStore,
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
    if (flags.has("token")) {
      throw new UsageError(
        "config set no longer writes a token in plaintext; run `coderax login` (or set CODERAX_TOKEN for automation)",
      );
    }
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

const LOCAL_INPUT_CODES = new Set([
  "CONVERSATION_ID_INVALID",
  "PROJECT_ID_INVALID",
  "ARTIFACT_ID_INVALID",
  "ARTIFACT_DESTINATION_EXISTS",
  "ARTIFACT_DESTINATION_INVALID",
  "ARTIFACT_DESTINATION_MISSING",
  "ARTIFACT_DESTINATION_SYMLINK",
  "CAPABILITY_INPUT_INVALID",
  "CAPABILITY_UNKNOWN",
  "UPLOAD_EMPTY",
  "UPLOAD_FIELD_INVALID",
  "UPLOAD_NOT_A_FILE",
  "UPLOAD_NOT_FOUND",
  "UPLOAD_PATH_REQUIRED",
  "UPLOAD_SYMLINK_REFUSED",
  "UPLOAD_TOO_LARGE",
  "UPLOAD_TYPE_MISMATCH",
  "UPLOAD_TYPE_NOT_ACCEPTED",
  "UPLOAD_TYPE_UNSUPPORTED",
  "UPLOAD_UNREADABLE",
  "ARTIFACT_PATH_INVALID",
  "ARTIFACT_DESTINATION_UNWRITABLE",
  "ARTIFACT_CONTENT_INVALID",
]);

function exitFor(error) {
  if (error instanceof UsageError || error instanceof ConfigError || error.code === "USAGE") {
    return EXIT.usage;
  }
  if (LOCAL_INPUT_CODES.has(error.code)) return EXIT.usage;
  if (error.code === "UNAUTHENTICATED") return EXIT.unauthenticated;
  if (error.code === "CREDENTIAL_STORE_UNAVAILABLE" || error.code === "CREDENTIAL_STORE_LOCKED") {
    return EXIT.unauthenticated;
  }
  if (error.code === "CREDENTIAL_CORRUPT" || error.code === "CREDENTIAL_WRITE_FAILED") {
    return EXIT.unauthenticated;
  }
  if (error.code === "UNAVAILABLE" || error.code === "CAPABILITY_NOT_AVAILABLE") {
    return EXIT.unavailable;
  }
  if (error.code === "CONTRACT_INCOMPATIBLE" || error.code === "CONTRACT_VIOLATION") {
    return EXIT.contract;
  }
  if (error.code === "CANCELLED") return EXIT.cancelled;
  if (error.code === "NOT_FOUND") return EXIT.notFound;
  if (
    error.code === "REQUEST_TIMEOUT" ||
    error.code === "NETWORK" ||
    error.code === "SERVER_ERROR" ||
    error.code === "RATE_LIMITED" ||
    error.code === "WAIT_TIMEOUT"
  ) {
    return EXIT.network;
  }
  if (error.code === "HTTP_401" || error.code === "HTTP_403") return EXIT.unauthenticated;
  if (error.code === "HTTP_404") return EXIT.notFound;
  if (error.code === "REQUEST_FAILED") return EXIT.network;
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
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal,
    stdinIsTTY: options.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    readSecret: options.readSecret ?? readStdin,
    credentialStore: options.credentialStore,
    platform: options.platform,
  };

  const write = (text) => deps.stdout(text.endsWith("\n") ? text : `${text}\n`);
  const raw = (text) => deps.stdout(String(text));
  let outputToken = null;

  try {
    const { flags, positionals, dynamic } = parseArgv(argv);

    if (flags.has("help")) {
      const target = positionals[0] ? COMMAND_ALIASES[positionals[0]] ?? positionals[0] : null;
      deps.stdout((target ? commandHelp(target) : null) ?? USAGE);
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

    const { call } = preflight(positionals, flags, dynamic);

    const settings = await resolveSettings(flags, deps);
    outputToken = settings.token;
    const [command] = positionals;
    const ctx = {
      ...settings,
      settings,
      command,
      args: positionals.slice(1),
      flags,
      options: dynamic,
      env: deps.env,
      json: flags.has("json"),
      stream: dynamic.has("stream") || flags.has("stream"),
      cwd: deps.cwd,
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
      case "capabilities":
        return await capabilities.capabilities(ctx);
      case "readiness":
        return await capabilities.readiness(ctx);
      case "artifacts":
        return await capabilities.artifacts(ctx);
      case "schedules":
        return await capabilities.schedules(ctx);
      case "permissions":
        return await capabilities.permissions(ctx);
      case "task":
        return await capabilities.task(ctx);
      case "completion":
        deps.stdout(completionScript(positionals[1], KNOWN_COMMANDS));
        return EXIT.ok;
      case "interactive":
        return await runInteractive(ctx, { mode: flags.get("mode") });
      case "capability":
        return await capabilities.runCapabilityGeneric({ ...ctx, args: positionals.slice(2) });
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
        if (isCapabilityCommand(command)) {
          return await capabilities.runCapability(command, ctx);
        }
        throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
    }
  } catch (error) {
    const known = error instanceof UsageError || error instanceof ConfigError || error instanceof CoderaxError;
    const detail =
      error instanceof UsageError ? error.message : `${error.code ?? "ERROR"}: ${error.message}`;
    deps.stderr(`coderax: ${redact(known ? detail : "unexpected failure", outputToken)}\n`);
    if (!known && deps.env.CODERAX_DEBUG) {
      deps.stderr(`${redact(error?.stack ?? String(error), outputToken)}\n`);
    }
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
  process.once("SIGINT", () => controller.abort());
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
}
