#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CoderaxError, EXIT, UsageError, errorDocument, exitFor } from "./errors.js";
import { createRuntime } from "./runtime.js";
import { VERSION } from "./version.js";
import { completionScript } from "./commands/completion.js";
import {
  COMMANDS,
  CONFIG_ACTIONS,
  DEPLOY_ACTIONS,
  ENGINE_ACTIONS,
  PERMISSIONS_ACTIONS,
  SESSIONS_ACTIONS,
  WORK_SUBCOMMANDS,
} from "./commands/registry.js";
import { configCommand } from "./commands/config.js";
import { login, logout, refreshAuth, status } from "./commands/auth.js";
import { chatCommand } from "./commands/chat.js";
import { workCommand } from "./commands/work.js";
import { sessionsCommand } from "./commands/sessions.js";
import { notificationsCommand } from "./commands/notifications.js";
import { permissionsCommand } from "./commands/permissions.js";
import {
  engineCapabilities,
  engineContract,
  engineHealth,
  engineReady,
  doctor,
  listAgents,
  listModels,
} from "./commands/engine.js";
import { deployCommand } from "./commands/deploy.js";
import { cloud, products, projects, update } from "./product-commands.js";
import { runInteractive } from "./interactive/app.js";

export { VERSION };

const USAGE = `coderax ${VERSION} - the Coderax terminal client

Usage:
  coderax                          Interactive Chat and Work terminal
  coderax chat [message]           One Chat turn (reads stdin when piped)
  coderax work [objective]         Submit a durable cloud Work task and stream it
  coderax work <command>           submit | list | status | watch | attach | report
                                   cancel | resume | retry | resolve | uncertain | templates
  coderax sessions [list|show|switch|new|current]
  coderax agents                   Agent identities, availability and capabilities
  coderax models                   Models, cost class and the zero-cost route
  coderax notifications            Durable completion notifications
  coderax permissions <taskId>     Pending approvals for a task
  coderax permissions decide <taskId> [requestId] --approve|--deny [--reason <text>]

  coderax login                    Store the owner token in the OS credential store
  coderax logout                   Remove the stored owner token
  coderax status                   Configuration, contract and local journal status
  coderax auth refresh             Refresh the owner token with the configured helper

  coderax engine [health|ready|contract|capabilities|agents|models]
  coderax doctor                   Diagnostics for the CLI, engine and credential store
  coderax config show|get|set|unset|path
  coderax completion bash|zsh|fish
  coderax update

  coderax compat | uninstall | cleanup
  coderax legacy <command>         Compatibility commands for older deployments

  Deployment surface (OpenAPI discovery):
  coderax deploy health|openapi|agents|models|call
  coderax health                   Alias for 'coderax engine health'
  coderax openapi                  Alias for 'coderax deploy openapi'
  coderax call <METHOD> <PATH> [--data <json>]
  coderax products | cloud | projects

Work templates:
  inspect | implement | test | diff | pr | review | ci
  coderax work --template implement "add the missing validation"

Global options:
  --engine-url <url>     WorkflowEngine URL (HTTPS, or HTTP on loopback)
  --base-url <url>       Coderax deployment URL for the OpenAPI surface
  --token <token>        One-shot owner token; prefer 'coderax login'
  --timeout <ms>         Per-request timeout, 100-120000 (default 30000)
  --model <provider/model>  Model for this invocation
  --agent <id>           coderax | opencode | freebuff
  --conversation <id>    Continue a specific engine conversation
  --json                 One machine-readable document on stdout
  --ndjson               One JSON event per line, then a result line
  --no-color             Disable ANSI styling
  --quiet                Suppress non-essential human output
  --verbose              More event and reconnect detail
  --config <path>        Override the config file
  --state <path>         Override the local journal
  -h, --help             Show this help
  -v, --version          Show the version

Environment:
  CODERAX_ENGINE_URL, CODERAX_BASE_URL, CODERAX_ENGINE_TOKEN, CODERAX_TOKEN,
  CODERAX_TIMEOUT_MS, CODERAX_CONFIG, CODERAX_CONFIG_DIR, CODERAX_AGENT,
  CODERAX_MODEL, CODERAX_CREDENTIAL_STORE

Exit codes:
  0 success            1 failure             2 usage/config
  3 authentication     4 network/timeout     5 not found
  6 unavailable        7 contract/capability 8 approval required
  9 submission uncertain  10 conflict/busy   130 cancelled

Security:
  Owner tokens are stored in the operating system credential store, never in
  config.json. Provider keys are never read, printed or inherited by a child
  process. Remote URLs must use HTTPS. The CLI never enables anonymous access.
`;

const KNOWN_COMMANDS = new Set(COMMANDS);

const BOOLEAN_FLAGS = new Set([
  "help", "version", "json", "ndjson", "no-color", "quiet", "verbose", "once",
  "detach", "new", "refresh", "retry-submission", "approve", "deny", "approve-all",
  "deny-all", "token-stdin", "unread", "no-watch",
]);

const VALUE_FLAGS = new Set([
  "base-url", "engine-url", "token", "timeout", "config", "state", "model", "agent",
  "conversation", "template", "after", "generation", "reason", "request", "limit",
  "mode", "budget-requests", "budget-input", "budget-output", "idempotency-key",
  "objective", "reasoning", "message", "max-reconnects", "task", "url", "data", "endpoint",
  "chat-path", "refresh-command", "credential-store", "theme", "output",
]);

const CONFIG_SET_FLAGS = new Set([
  "base-url", "engine-url", "timeout", "endpoint", "chat-path", "model", "agent",
  "credential-store", "refresh-command", "theme", "output",
]);

const WORK_SUBCOMMAND_SET = new Set(WORK_SUBCOMMANDS);

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function parseArgv(argv) {
  const flags = new Map();
  const positionals = [];
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (literal) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg !== "-") {
      throw new UsageError(`unknown option: ${arg}`);
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      if (BOOLEAN_FLAGS.has(name)) {
        if (equals !== -1) throw new UsageError(`--${name} does not take a value`);
        flags.set(name, true);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) {
        throw new UsageError(`unknown option: --${name}`);
      }
      if (equals !== -1) {
        const value = body.slice(equals + 1);
        if (value === "") throw new UsageError(`--${name} requires a value`);
        flags.set(name, value);
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || (String(value).startsWith("--") && String(value) !== "--")) {
        throw new UsageError(`--${name} requires a value`);
      }
      flags.set(name, String(value));
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function preflight(positionals, flags) {
  const [command] = positionals;
  if (!KNOWN_COMMANDS.has(command)) {
    throw new UsageError(`unknown command: ${command}. Run \`coderax --help\`.`);
  }
  if (flags.has("json") && flags.has("ndjson")) {
    throw new UsageError("--json and --ndjson are mutually exclusive");
  }
  if (flags.has("approve") && flags.has("deny")) {
    throw new UsageError("--approve and --deny are mutually exclusive");
  }
  if (flags.has("approve-all") && flags.has("deny-all")) {
    throw new UsageError("--approve-all and --deny-all are mutually exclusive");
  }
  if (flags.has("token") && flags.has("token-stdin")) {
    throw new UsageError("use --token or --token-stdin, not both");
  }
  if (flags.has("timeout")) {
    const timeout = Number(flags.get("timeout"));
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
      throw new UsageError("--timeout must be an integer between 100 and 120000");
    }
  }

  let call = null;
  if (command === "call" || (command === "deploy" && positionals[1] === "call")) {
    const offset = command === "deploy" ? 2 : 1;
    const methodRaw = positionals[offset];
    const path = positionals[offset + 1];
    if (methodRaw === undefined || path === undefined) {
      throw new UsageError("call requires <METHOD> <PATH>");
    }
    const method = methodRaw.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new UsageError(`unsupported method: ${methodRaw}`);
    if (flags.has("data")) {
      if (method === "GET" || method === "HEAD") throw new UsageError(`${method} does not accept --data`);
      try {
        call = { method, path, body: JSON.parse(flags.get("data")) };
      } catch {
        throw new UsageError("--data must be valid JSON");
      }
    } else {
      call = { method, path, body: undefined };
    }
  }

  if (command === "work") {
    const sub = positionals[1];
    if (sub === "resolve" && (!positionals[2] || !positionals[3])) {
      throw new UsageError("work resolve requires <submission-key> <task-id>");
    }
    if (sub && !WORK_SUBCOMMAND_SET.has(sub) && sub.startsWith("-")) {
      throw new UsageError(`unknown work command: ${sub}`);
    }
  }

  if (command === "permissions" && positionals[1] === "decide") {
    if (!positionals[2]) throw new UsageError("permissions decide requires a task id");
    if (!flags.has("approve") && !flags.has("deny")) {
      throw new UsageError("permissions decide requires --approve or --deny");
    }
  }

  if (command === "config") {
    const action = positionals[1] ?? "show";
    if (!CONFIG_ACTIONS.includes(action)) {
      throw new UsageError(`unknown config action: ${action}`);
    }
    if (action === "get" && !positionals[2]) throw new UsageError("config get requires a key");
    if (action === "unset" && !positionals[2]) throw new UsageError("config unset requires a key");
    if (action === "set") {
      if (flags.has("token")) throw new UsageError("the owner token is stored by `coderax login`, not by `config set`");
      const hasFlag = [...CONFIG_SET_FLAGS].some((name) => flags.has(name));
      const key = positionals[2];
      if (key && hasFlag) throw new UsageError("config set accepts either a key and value or flags, not both");
      if (!key && !hasFlag) throw new UsageError("config set requires a key and value, or --engine-url/--base-url/...");
      if (key && positionals.length < 4) throw new UsageError(`config set ${key} requires a value`);
    }
  }

  if (command === "engine") {
    const action = positionals[1] ?? "health";
    if (!ENGINE_ACTIONS.includes(action)) {
      throw new UsageError(`unknown engine action: ${action}`);
    }
  }

  if (command === "deploy") {
    const action = positionals[1] ?? "health";
    if (!DEPLOY_ACTIONS.includes(action)) {
      throw new UsageError(`unknown deploy action: ${action}`);
    }
  }

  if (command === "sessions") {
    const action = positionals[1] ?? "list";
    if (!SESSIONS_ACTIONS.includes(action)) {
      throw new UsageError(`unknown sessions action: ${action}`);
    }
  }

  if (command === "permissions") {
    const arg = positionals[1];
    if (arg !== undefined && !PERMISSIONS_ACTIONS.includes(arg) && positionals.length > 2) {
      throw new UsageError(`unknown permissions action: ${arg}`);
    }
  }

  if (command === "auth") {
    const action = positionals[1] ?? "refresh";
    if (action !== "refresh") throw new UsageError(`unknown auth action: ${action}`);
  }

  return { call };
}

function interactiveFactory(runtime) {
  return (mode) => runInteractive(runtime, { initialMode: mode });
}

async function dispatch(runtime, command, positionals, call, options) {
  const rest = positionals.slice(1);
  switch (command) {
    case "chat":
      return chatCommand(runtime, rest, { interactive: interactiveFactory(runtime) });
    case "work":
      return workCommand(runtime, rest, { interactive: interactiveFactory(runtime) });
    case "sessions":
      return sessionsCommand(runtime, rest);
    case "agents":
      return listAgents(runtime);
    case "models":
      return listModels(runtime);
    case "notifications":
      return notificationsCommand(runtime);
    case "permissions": {
      const explicitAction = rest[0] === "list" || rest[0] === "decide";
      return permissionsCommand(runtime, explicitAction ? rest : ["list", ...rest]);
    }
    case "login":
      return login(runtime);
    case "logout":
      return logout(runtime);
    case "status":
      return status(runtime);
    case "auth":
      return refreshAuth(runtime);
    case "engine": {
      const action = rest[0] ?? "health";
      if (action === "health") return engineHealth(runtime);
      if (action === "ready") return engineReady(runtime);
      if (action === "contract") return engineContract(runtime);
      if (action === "capabilities") return engineCapabilities(runtime);
      if (action === "agents") return listAgents(runtime);
      if (action === "models") return listModels(runtime);
      throw new UsageError(`unknown engine action: ${action}`);
    }
    case "doctor":
      return doctor(runtime);
    case "config":
      return configCommand(runtime, rest);
    case "products":
      return products(runtime);
    case "cloud":
      return cloud(runtime);
    case "projects":
      return projects(runtime);
    case "update":
      return update(runtime);
    case "deploy":
      return deployCommand(runtime, rest, call);
    case "health":
      return engineHealth(runtime);
    case "openapi":
      return deployCommand(runtime, ["openapi"], call);
    case "call":
      return deployCommand(runtime, ["call"], call);
    case "completion": {
      const script = completionScript(rest[0]);
      runtime.raw(script);
      return EXIT.OK;
    }
    case "help":
      runtime.raw(USAGE);
      return EXIT.OK;
    case "version":
      runtime.write(`coderax-cli ${VERSION}`);
      return EXIT.OK;
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function installSignals(options) {
  if (options.handleSignals === false) return { controller: new AbortController(), cleanup: () => {} };
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal.reason), { once: true });
  }
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1 && !controller.signal.aborted) {
      controller.abort("cancel");
      return;
    }
    process.exitCode = EXIT.CANCELLED;
    process.exit(EXIT.CANCELLED);
  };
  process.on("SIGINT", onSigint);
  return {
    controller,
    cleanup: () => process.removeListener("SIGINT", onSigint),
  };
}

function writeFailure(runtime, error, command, options, argv = []) {
  const code = exitFor(error);
  const message = runtime ? runtime.redact(error?.message ?? String(error)) : String(error?.message ?? error);
  const hint = runtime ? runtime.redact(error?.hint ?? "") : error?.hint;
  const jsonFallback = argv.includes("--json") || argv.includes("--ndjson");
  if (runtime?.json || runtime?.ndjson) {
    const doc = errorDocument({ ...error, message, hint, details: runtime?.redactValue(error?.details) }, { command });
    runtime.write(JSON.stringify(doc));
  } else if (!runtime && jsonFallback) {
    const doc = errorDocument({ ...error, message, hint }, { command });
    (options.stdout ?? ((text) => process.stdout.write(text)))(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    const writer = runtime?.err ?? ((text) => (options?.stderr ?? process.stderr.write)(text));
    if (error instanceof UsageError || error?.code === "USAGE") {
      writer(`coderax: ${message}`);
    } else if (error instanceof CoderaxError || error?.code) {
      writer(`coderax: ${error.code}: ${message}`);
    } else {
      writer(`coderax: unexpected failure: ${message}`);
    }
    if (hint) writer(`  \u2192 ${hint}`);
    if (error?.requestId) writer(`  request ${error.requestId}`);
  }
  return code;
}

export async function runCli(argv, options = {}) {
  let runtime = null;
  let command = null;
  let signals = null;
  try {
    // Select compatibility mode explicitly; never fall back after an engine error.
    if (argv[0] === "legacy" || ["compat", "uninstall", "cleanup"].includes(argv[0])) {
      const { runCli: runLegacyCli } = await import("./legacy-cli.js");
      return await runLegacyCli(argv[0] === "legacy" ? argv.slice(1) : argv, options);
    }
    const { flags, positionals } = parseArgv(argv);

    if (flags.has("help") || positionals[0] === "help") {
      (options.stdout ?? ((text) => process.stdout.write(text)))(USAGE);
      return EXIT.OK;
    }
    if (positionals[0] === "version" && flags.has("json")) {
      const { collectVersionInfo } = await import("./diagnostics.js");
      (options.stdout ?? ((text) => process.stdout.write(text)))(JSON.stringify(collectVersionInfo({ env: options.env }), null, 2) + "\n");
      return EXIT.OK;
    }
    if (flags.has("version") || positionals[0] === "version") {
      (options.stdout ?? ((text) => process.stdout.write(text)))(`coderax-cli ${VERSION}\n`);
      return EXIT.OK;
    }
    if (positionals.length === 0) {
      const tty = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
      if (!tty) {
        (options.stdout ?? ((text) => process.stdout.write(text)))(USAGE);
        return EXIT.OK;
      }
      signals = options.handleSignals === false ? null : installSignals(options);
      runtime = await createRuntime({ flags, options, command: "interactive" });
      return await runInteractive(runtime);
    }

    command = positionals[0];
    const { call } = preflight(positionals, flags);

    if (command === "completion") {
      const script = completionScript(positionals[1]);
      (options.stdout ?? ((text) => process.stdout.write(text)))(script);
      return EXIT.OK;
    }

    signals = installSignals(options);
    runtime = await createRuntime({ flags, options, command });
    runtime.args = positionals.slice(1);
    return await dispatch(runtime, command, positionals, call, options);
  } catch (error) {
    return writeFailure(runtime, error, command, options, argv);
  } finally {
    signals?.cleanup();
  }
}

export function isEntrypoint(entry = process.argv[1]) {
  if (entry === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return entry === modulePath;
  }
}

if (isEntrypoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
