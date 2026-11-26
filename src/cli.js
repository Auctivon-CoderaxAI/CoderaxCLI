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
import * as workflow from "./workflow-commands.js";
import * as maintenance from "./maintenance.js";
import * as engine from "./engine-commands.js";
import {
  BOOLEAN_GLOBAL_FLAGS,
  GLOBAL_FLAGS,
  TOP_LEVEL_COMMAND_NAMES,
  completionScript,
  findTopLevelCommand,
  renderTopLevelUsage,
} from "./command-registry.js";
import { collectVersionInfo, formatVersionInfo } from "./diagnostics.js";
import { SdkError } from "../packages/workflow-sdk/src/index.js";
import { VERSION } from "./version.js";

export { VERSION };

const USAGE = `coderax ${VERSION} - owner-only cloud client for a Coderax deployment

Usage:
${renderTopLevelUsage()}

Global options:
  --base-url <url>   Override the deployment URL (HTTPS, or HTTP on loopback)
  --token-file <p>   Read the bearer token from a 0600 file (never argv)
  --timeout <ms>     Per-request timeout, 100-120000
  --model <id>       Override the model for one invocation
  --agent <id>       Select an agent for chat, Work or an autonomous build
  --endpoint <name>  Override the chat endpoint name
  --chat-path <path> Override the streaming path
  --url <path>       Override the streaming path for one invocation
  --conversation <id> Continue a specific conversation
  --new              Start a new conversation
  --strict           Fail on unverified API version or missing capabilities
  --max-retries <n>  Reconnect attempts for durable run monitoring (0-10)
  --json             Machine-readable output (run monitoring emits NDJSON)
  --yes, --dry-run   Confirm or preview the uninstall command
  --purge            With uninstall: also remove stored credentials
  --no-color         Accepted for compatibility
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  CODERAX_BASE_URL, CODERAX_TOKEN, CODERAX_TIMEOUT_MS, CODERAX_CONFIG,
  CODERAX_CONFIG_DIR, CODERAX_CHAT_PATH, CODERAX_ENDPOINT, CODERAX_MODEL,
  CODERAX_AGENT, CODERAX_CREDENTIAL_STORE

Tokens: passing a token as a command-line argument is refused because it would
appear in shell history and process listings. Use \`coderax login\` (secure
prompt), \`--token-file <path>\`, stdin, or CODERAX_TOKEN. Tokens are stored in
the operating-system credential store when one offers a non-argv interface, and
in a 0600 config file otherwise.

Release: \`version\` reports the install and compatibility contract, \`compat\`
checks the deployment's API-version handshake, and \`uninstall\` removes local
user data only. Upgrades and uninstalls never run automatically.

Exit codes:
  0 ok, 1 failed operation/task, 2 usage, 3 unauthenticated/not owner,
  4 network or timeout, 5 not found, 6 backend capability or API version
  unavailable, 7 contract violation (including incomplete streams), 130 cancelled.

Discovery: agents, models, and openapi use the deployment's OpenAPI document
(\`--work\` uses the Work-eligible routes). health probes fixed paths. login and
whoami verify /api/user and require the owner role. chat and work use the native
Work chat SSE endpoint. Durable Work uses /api/workflows; a deployment without
it fails closed with CAPABILITY_UNAVAILABLE.
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
  agent: "agent",
}));
const CONFIG_FLAGS = ["base-url", "timeout", "chat-path", "endpoint", "model", "agent"];

const KNOWN_COMMANDS = new Set(TOP_LEVEL_COMMAND_NAMES);
const KNOWN_FLAGS = new Set(GLOBAL_FLAGS);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const BOOLEAN_FLAGS = new Set(BOOLEAN_GLOBAL_FLAGS);

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
    if (arg === "--token" || arg.startsWith("--token=")) {
      throw new UsageError(
        "--token is refused: a token in argv leaks into shell history and process listings. " +
          "Use `coderax login` (secure prompt), `--token-file <path>`, stdin, or CODERAX_TOKEN.",
      );
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
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
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
  const token = config.token;
  const timeoutMs = config.timeoutMs;

  // `config` commands must work on a fresh install, so the base URL is only
  // required by the commands that actually send requests.
  return {
    ...config,
    baseUrl,
    token: token || null,
    timeoutMs,
    model: flags.has("model") ? flags.get("model") : config.model,
    agent: flags.has("agent") ? flags.get("agent") : config.agent,
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

async function commandHealth(ctx, deps) {
  const { path, response } = await product.probeHealth({ ...ctx.settings, fetchImpl: deps.fetchImpl });
  const body = responseBody(response);
  emit(
    ctx.out,
    ctx.flags,
    `health: ok (GET ${path}) HTTP ${response.status}\n${response.json ? formatJson(response.json) : ""}`,
    { endpoint: path, status: response.status, body },
  );
}

async function commandOpenapi(ctx, deps) {
  const discovery = await discoverOpenApi({ ...ctx.settings, fetchImpl: deps.fetchImpl });
  const displayOperations = discovery.operations.map((operation) => ({
    ...operation,
    path: redact(operation.path, ctx.token),
    operationId: operation.operationId ? redact(operation.operationId, ctx.token) : null,
    summary: operation.summary ? redact(operation.summary, ctx.token) : null,
  }));
  const lines = displayOperations
    .slice(0, 50)
    .map((operation) => `  ${operation.method.padEnd(6)} ${operation.path}${operation.operationId ? `  # ${operation.operationId}` : ""}`);
  emit(
    ctx.out,
    ctx.flags,
    `contract: ${discovery.sourcePath} (${displayOperations.length} operations)\n${lines.join("\n")}\n`,
    {
      sourcePath: discovery.sourcePath,
      operationCount: displayOperations.length,
      operations: displayOperations,
    },
  );
}

async function commandResource(kind, ctx, deps) {
  const discovery = await discoverOpenApi({ ...ctx.settings, fetchImpl: deps.fetchImpl });
  const matcher = kind === "agents" ? /\/agents\/?$/i : /\/models\/?$/i;
  const operation = findOperation(discovery.operations, matcher);

  if (operation === null) {
    throw new CoderaxError(
      "OPERATION_NOT_FOUND",
      `the deployment's OpenAPI document has no GET ${kind} operation; run \`coderax openapi\` to list available paths`,
    );
  }

  const response = await request({
    ...ctx.settings,
    path: operation.path,
    fetchImpl: deps.fetchImpl,
  });
  const payload = responseBody(response);
  const displayPath = redact(operation.path, ctx.token);

  emit(
    ctx.out,
    ctx.flags,
    `${operation.method} ${displayPath} -> ${response.status}\n${response.json ? formatJson(response.json) : response.text}\n`,
    { method: operation.method, path: displayPath, status: response.status, body: payload },
  );
}

async function commandCall(ctx, deps) {
  const { method, path, body } = ctx.call;
  const response = await request({ ...ctx.settings, path, method, body, fetchImpl: deps.fetchImpl });
  const payload = responseBody(response);
  const displayPath = redact(path, ctx.token);

  emit(
    ctx.out,
    ctx.flags,
    `${method} ${displayPath} -> ${response.status}\n${response.json !== null ? formatJson(response.json) : response.text}\n`,
    { method, path: displayPath, status: response.status, body: payload },
  );
}

async function commandConfig(ctx, deps) {
  const positionals = ctx.args;
  const action = positionals[0] ?? "show";
  const { flags } = ctx;
  const write = ctx.out;

  if (action === "show" || action === "list") {
    const described = describeConfig(ctx);
    emit(
      write,
      flags,
      `config: ${described.configPath}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\ntimeout: ${described.timeoutMs}ms\nchat path: ${described.chatPath}\nendpoint: ${described.endpoint}\nmodel: ${described.model || "(not set)"}\nagent: ${described.agent || "(not set)"}\nowner role: ${described.role ?? "(unverified)"}\nconversations: ${described.conversationCount}\n`,
      described,
    );
    return;
  }

  if (action === "get") {
    const key = positionals[1];
    if (!key || !(key in CONFIG_KEYS)) {
      throw new UsageError(`config get requires one of: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    }
    const value = ctx[CONFIG_KEYS[key]];
    write(flags.has("json") ? formatJson({ [key]: value }) : String(value || "(unset)"));
    return;
  }

  if (action !== "set") {
    throw new UsageError(`unknown config action: ${action}`);
  }

  const patch = {};
  const key = positionals[1];
  const hasFlags = CONFIG_FLAGS.some((name) => flags.has(name));
  if (key && key in CONFIG_KEYS && !hasFlags) {
    const value = positionals.slice(2).join(" ").trim();
    if (!value) throw new UsageError(`config set ${key} requires a value`);
    patch[CONFIG_KEYS[key]] = value;
  } else {
    if (flags.has("base-url")) patch.baseUrl = flags.get("base-url");
    if (flags.has("chat-path")) patch.chatPath = flags.get("chat-path");
    if (flags.has("endpoint")) patch.endpoint = flags.get("endpoint");
    if (flags.has("model")) patch.model = flags.get("model");
    if (flags.has("agent")) patch.agent = flags.get("agent");
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
    filePath: ctx.configPath,
  });
  const described = describeConfig(
    await loadConfig({ env: deps.env, filePath: saved.path }),
  );

  emit(write, flags, `wrote ${saved.path}\nbase URL: ${described.baseUrl ?? "(not set)"}\ntoken: ${described.tokenConfigured ? "configured" : "not configured"}\n`, described);
}

/**
 * The one dispatch table. `src/command-registry.js` maps every top-level
 * command to one of these keys; the parity test fails when a command has no
 * handler or a handler is unreachable. Adding a command means adding one
 * registry entry and one implementation, never a second switch or help list.
 */
export const TOP_LEVEL_HANDLERS = Object.freeze({
  "product.products": (ctx) => product.products(ctx),
  "product.cloud": (ctx) => product.cloud(ctx),
  "product.projects": (ctx) => product.projects(ctx),
  "product.status": (ctx) => product.status(ctx),
  "product.login": (ctx) => product.login(ctx),
  "product.logout": (ctx) => product.logout(ctx),
  "product.doctor": (ctx) => product.doctor(ctx),
  "product.update": (ctx) => product.update(ctx),
  "product.compat": (ctx) => product.compat(ctx),
  "workflow.whoami": (ctx) => workflow.whoamiCommand(ctx),
  "workflow.chat": (ctx) => workflow.chatCommand(ctx, ctx.args),
  "workflow.work": (ctx) => workflow.workCommand(ctx, ctx.args),
  "workflow.tasks": (ctx) => workflow.tasksCommand(ctx, ctx.args),
  "workflow.workflows": (ctx) => workflow.workflowsCommand(ctx),
  "workflow.runs": (ctx) => workflow.runsCommand(ctx),
  "workflow.run": (ctx) => workflow.runCommand(ctx, ctx.args),
  "workflow.cancel": (ctx) => workflow.cancelCommand(ctx, ctx.args),
  "workflow.resume": (ctx) => workflow.resumeCommand(ctx, ctx.args),
  "workflow.retry": (ctx) => workflow.retryCommand(ctx, ctx.args),
  "workflow.approve": (ctx) => workflow.approveCommand(ctx, ctx.args),
  "workflow.repos": (ctx) => workflow.reposCommand(ctx),
  "workflow.agents": (ctx, deps) =>
    ctx.flags.has("work") ? workflow.workAgentsCommand(ctx) : commandResource("agents", ctx, deps),
  "workflow.models": (ctx, deps) =>
    ctx.flags.has("work") ? workflow.workModelsCommand(ctx) : commandResource("models", ctx, deps),
  "maintenance.uninstall": (ctx) => maintenance.uninstall(ctx),
  "engine.run": (ctx) => engine.runEngineCommand(ctx),
  "cli.config": (ctx, deps) => commandConfig(ctx, deps),
  "cli.health": (ctx, deps) => commandHealth(ctx, deps),
  "cli.openapi": (ctx, deps) => commandOpenapi(ctx, deps),
  "cli.call": (ctx, deps) => commandCall(ctx, deps),
  "cli.help": (ctx, deps) => {
    deps.stdout(USAGE);
  },
  "cli.version": (ctx, deps) => {
    deps.stdout(ctx.json ? formatJson(ctx.install) : formatVersionInfo(ctx.install));
  },
  "cli.completion": (ctx, deps) => {
    deps.stdout(completionScript(ctx.args[0]));
  },
});

function exitFor(error) {
  if (error instanceof UsageError || error instanceof ConfigError || error.code === "USAGE") {
    return EXIT.usage;
  }
  if (
    error.code === "CONTRACT_VIOLATION" ||
    error.code === "STREAM_INCOMPLETE" ||
    error.code === "RESUME_UNSUPPORTED" ||
    error.code === "UNKNOWN_RUN_STATUS"
  ) {
    return EXIT.contract;
  }
  if (
    error.code === "UNAVAILABLE" ||
    error.code === "CAPABILITY_UNAVAILABLE" ||
    error.code === "API_VERSION_UNSUPPORTED" ||
    error.code === "API_VERSION_UNVERIFIED" ||
    error.code === "OWNER_UNVERIFIABLE"
  ) {
    return EXIT.unavailable;
  }
  if (error.code === "CANCELLED") return EXIT.cancelled;
  if (
    error.code === "UNAUTHENTICATED" ||
    error.code === "FORBIDDEN" ||
    error.code === "unauthorized" ||
    error.code === "forbidden" ||
    error.code === "HTTP_401" ||
    error.code === "HTTP_403"
  ) {
    return EXIT.unauthenticated;
  }
  if (
    error.code === "NOT_FOUND" ||
    error.code === "not_found" ||
    error.code === "HTTP_404"
  ) {
    return EXIT.notFound;
  }
  if (
    error.code === "NETWORK" ||
    error.code === "TIMEOUT" ||
    error.code === "REQUEST_TIMEOUT" ||
    error.code === "REQUEST_FAILED" ||
    error.code === "STREAM_DISCONNECTED"
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
    confirm: options.confirm ?? defaultConfirm,
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

    if (positionals[0] === "completion") {
      const shell = positionals[1];
      if (!["bash", "zsh", "fish"].includes(shell)) {
        throw new UsageError("completion requires one of: bash, zsh, fish");
      }
      deps.stdout(completionScript(shell));
      return EXIT.ok;
    }

    // Diagnostics must work before configuration exists and even when the
    // config file is unreadable; neither answer needs the deployment.
    if (positionals[0] === "version") {
      const info = deps.install ?? collectVersionInfo({ env: deps.env });
      deps.stdout(flags.has("json") ? formatJson(info) : formatVersionInfo(info));
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
      confirm: deps.confirm,
      install: deps.install ?? collectVersionInfo({ env: deps.env }),
    };

    const entry = findTopLevelCommand(command);
    if (entry === null) {
      throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
    }

    ctx.call = call;
    if (entry.requiresBaseUrl) requireBaseUrl(ctx);

    const handler = TOP_LEVEL_HANDLERS[entry.handler];
    if (typeof handler !== "function") {
      throw new UsageError(`command ${command} has no handler (${entry.handler})`);
    }

    const result = await handler(ctx, deps);
    return typeof result === "number" ? result : EXIT.ok;
  } catch (error) {
    const known =
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof CoderaxError ||
      error instanceof SdkError ||
      error.code === "USAGE";
    const detail =
      error instanceof UsageError || error.code === "USAGE"
        ? error.message
        : `${error.code ?? "ERROR"}: ${error.message}`;
    deps.stderr(`coderax: ${known ? detail : "unexpected failure"}\n`);
    return exitFor(error);
  }
}

async function defaultConfirm(question) {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return promptHidden();
  }
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

/**
 * Read a secret from a terminal with echo disabled. Without this the token
 * would be echoed to the screen and captured by terminal recording, which is
 * the same exposure as putting it in argv.
 */
async function promptHidden(question = "Deployment token (input hidden): ") {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return "";
  stderr.write(question);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const cleanup = (clear) => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdin.removeListener("data", onData);
      if (clear) stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup(true);
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup(true);
          resolve("");
          process.exitCode = 130;
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
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
