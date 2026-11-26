/**
 * `coderax engine ...` adapter.
 *
 * The engine command handlers themselves are adopted verbatim from
 * `feat/engine-thin-client-v1` as `engine-surface.js`. This file is the thin
 * integration layer this branch owns:
 *
 *  - validate the served contract and owner token before an authenticated
 *    handler runs;
 *  - validate identifiers before they reach a route;
 *  - preserve the CLI's secure login/logout and registry-driven capability
 *    matrix;
 *  - sanitize human output while leaving JSON authoritative;
 *  - fail closed for commands the 1.0.0 contract does not implement.
 *
 * It deliberately does not reimplement Chat, Work, task control, permissions,
 * conversations, memory or artifact metadata.
 */
import { CoderaxError, formatJson } from "./client.js";
import { loadConfig, maskToken, saveConfig } from "./config.js";
import { credentialBackend, readTokenFile } from "./credentials.js";
import {
  ENGINE_COMMANDS,
  ENGINE_CONTRACT_VERSION,
  findEngineCommand,
} from "./command-registry.js";
import {
  assertIdentifier,
  connectEngine,
  engineHealth,
  engineReady,
} from "./engine-client.js";
import * as surface from "./engine-surface.js";

const WORK_KEYS = new Set([
  "objective",
  "conversationId",
  "agent",
  "model",
  "mode",
  "requireApproval",
]);

const TASK_COMMANDS = new Set([
  "task",
  "events",
  "cancel",
  "resume",
  "retry",
  "permissions",
  "artifacts",
  "approve",
  "deny",
]);

export class EngineUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineUsageError";
    this.code = "USAGE";
  }
}

/**
 * Backend text is untrusted. Strip ANSI/OSC escapes and C0/C1 controls before
 * writing it to a terminal; JSON output keeps the authoritative value.
 */
function safeText(value) {
  return String(value ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function print(ctx, human, machine) {
  ctx.out(ctx.json ? formatJson(machine) : human);
}

function requireValue(ctx, name, label) {
  const value = ctx.flags.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new EngineUsageError(`${label ?? `--${name}`} requires a value`);
  }
  return value.trim();
}

function parseJsonBody(ctx) {
  const raw = requireValue(ctx, "data", "--data");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EngineUsageError("--data must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EngineUsageError("--data must be a JSON object");
  }
  return parsed;
}

function validateWorkBody(body) {
  for (const key of Object.keys(body)) {
    if (!WORK_KEYS.has(key)) {
      throw new EngineUsageError(`--data contains an unsupported Work field: ${key}`);
    }
  }
  if (typeof body.objective !== "string" || body.objective.trim() === "") {
    throw new EngineUsageError("Work requires a non-empty objective");
  }
  if (body.objective.length > 200_000) {
    throw new EngineUsageError("the Work objective is longer than 200000 characters");
  }
  if (body.mode !== undefined && !["private", "cloud"].includes(body.mode)) {
    throw new EngineUsageError("Work mode must be private or cloud");
  }
  if (body.agent !== undefined && !["coderax", "opencode", "freebuff"].includes(body.agent)) {
    throw new EngineUsageError("Work agent must be coderax, opencode or freebuff");
  }
  if (body.model !== undefined) {
    if (
      body.model === null ||
      typeof body.model !== "object" ||
      typeof body.model.providerId !== "string" ||
      typeof body.model.modelId !== "string" ||
      body.model.providerId === "" ||
      body.model.modelId === ""
    ) {
      throw new EngineUsageError("Work model must be { providerId, modelId }");
    }
  }
  return body;
}

function blocked(ctx, name, reason) {
  const machine = {
    capability: `engine.${name}`,
    status: "blocked",
    contractVersion: ENGINE_CONTRACT_VERSION,
    reason,
  };
  print(ctx, `engine ${name}: blocked - ${reason}`, machine);
  return 6;
}

function printHelp(ctx, name) {
  if (name) {
    const command = findEngineCommand(name);
    if (command === null) throw new EngineUsageError(`unknown engine command: ${name}`);
    print(
      ctx,
      `${command.usage}\n  ${command.summary ?? command.reason ?? ""}\n  status: ${command.status}`,
      command,
    );
    return 0;
  }
  const available = ENGINE_COMMANDS.filter((command) => command.status === "available");
  const blockedCommands = ENGINE_COMMANDS.filter((command) => command.status === "blocked");
  const lines = [
    `coderax engine - authoritative WorkflowEngine ${ENGINE_CONTRACT_VERSION} commands`,
    "",
    "Available:",
    ...available.map((command) => `  ${command.usage}\n    ${command.summary}`),
    "",
    "Blocked by the 1.0.0 contract (no request is sent):",
    ...blockedCommands.map((command) => `  engine ${command.name} - ${command.reason}`),
    "",
    "Run `coderax engine capabilities --json` for the machine-readable matrix.",
  ];
  ctx.out(
    ctx.json
      ? formatJson({ contractVersion: ENGINE_CONTRACT_VERSION, commands: ENGINE_COMMANDS })
      : lines.join("\n"),
  );
  return 0;
}

async function commandLogin(ctx) {
  if (!ctx.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no engine deployment configured; set CODERAX_BASE_URL or pass --base-url <url>",
    );
  }
  const tokenFile = ctx.flags.get("token-file");
  let token;
  if (tokenFile) {
    try {
      token = await readTokenFile(tokenFile);
    } catch (error) {
      throw new CoderaxError("TOKEN_FILE", error.message);
    }
  } else {
    token = ctx.env.CODERAX_TOKEN?.trim() || String(await ctx.readSecret()).trim();
  }
  if (!token) {
    throw new EngineUsageError(
      "no token provided; run `coderax engine login` at a terminal, pipe it on stdin, use `--token-file <path>`, or set CODERAX_TOKEN",
    );
  }

  // Owner proof before persistence. The engine has one principal, so an
  // owner-only operation succeeding is the authorization proof.
  const connected = await connectEngine({ ...ctx, token });

  let store = credentialBackend(ctx.env);
  const record = { token, account: null, baseUrl: ctx.baseUrl };
  try {
    await saveConfig(record, {
      filePath: ctx.settings.configPath,
      credentialStore: store,
      env: ctx.env,
    });
  } catch (error) {
    if (store === "file") throw error;
    ctx.err(`coderax: credential store unavailable (${error.message}); using the 0600 config file`);
    store = "file";
    await saveConfig(record, {
      filePath: ctx.settings.configPath,
      credentialStore: "file",
      env: ctx.env,
    });
  }

  print(
    ctx,
    `engine login: owner token accepted\ncontract: ${connected.contract.version}\nstored: ${store === "file" ? "0600 config file" : `OS credential store (${store})`}`,
    {
      authenticated: true,
      owner: true,
      token: maskToken(token),
      baseUrl: ctx.baseUrl,
      contractVersion: connected.contract.version,
      store,
    },
  );
  return 0;
}

async function commandLogout(ctx) {
  const stored = await loadConfig({ env: {}, filePath: ctx.settings.configPath });
  const removed = Boolean(stored.token);
  const environmentTokenActive = Boolean(ctx.env.CODERAX_TOKEN?.trim());
  await saveConfig(
    { token: null, account: null },
    {
      filePath: ctx.settings.configPath,
      credentialStore: stored.tokenStore ?? "file",
      env: ctx.env,
    },
  );
  const message = environmentTokenActive
    ? "Stored credentials cleared. CODERAX_TOKEN is still set; unset it to sign out of this environment."
    : removed
      ? "Signed out."
      : "No stored credentials.";
  print(ctx, message, { removed, environmentTokenActive, message });
  return 0;
}

async function commandHealth(ctx) {
  const health = await engineHealth(ctx);
  print(
    ctx,
    `engine health: ${health.report.status}\ncontract: ${health.contract.version}\nstarted: ${health.report.startedAt}\nuptime: ${health.report.uptimeMs}ms`,
    { status: health.report.status, contractVersion: health.contract.version, report: health.report },
  );
  return health.report.status === "failed" ? 1 : 0;
}

async function commandReady(ctx) {
  const health = await engineHealth(ctx);
  const ready = await engineReady(ctx);
  print(
    ctx,
    `engine ready: ${ready.report.ready ? "yes" : "no"}\ncontract: ${health.contract.version}${ready.report.missing?.length ? `\nmissing: ${ready.report.missing.join(", ")}` : ""}`,
    { contractVersion: health.contract.version, ...ready.report },
  );
  return ready.report.ready ? 0 : 6;
}

async function commandCompat(ctx) {
  const health = await engineHealth(ctx);
  let authenticated = false;
  let agents = null;
  let authError = null;
  if (ctx.token) {
    try {
      const connected = await connectEngine(ctx);
      authenticated = true;
      agents = connected.agents;
    } catch (error) {
      if (error instanceof CoderaxError) {
        authError = { code: error.code, message: error.message };
      } else {
        throw error;
      }
    }
  }
  const result = {
    contractVersion: health.contract.version,
    supportedContract: `${ENGINE_CONTRACT_VERSION}.x`,
    authenticated,
    owner: authenticated,
    agents: agents?.length ?? null,
    ...(authError ? { authenticationError: authError } : {}),
  };
  if (ctx.json) ctx.out(formatJson(result));
  else {
    ctx.out(
      `engine compat: ${health.contract.version} (supported ${ENGINE_CONTRACT_VERSION}.x)\nowner token: ${authenticated ? "verified" : ctx.token ? "rejected" : "not configured"}${authError ? `\n${authError.code}: ${authError.message}` : ""}`,
    );
  }
  if (ctx.flags.has("strict") && !authenticated) return 6;
  if (authError?.code === "API_VERSION_UNSUPPORTED") return 6;
  if (authError?.code === "UNAUTHENTICATED" || authError?.code === "FORBIDDEN") return 3;
  return 0;
}

async function commandVerify(ctx) {
  const connected = await connectEngine(ctx);
  const result = {
    contractVersion: connected.contract.version,
    authenticated: true,
    owner: true,
    identity: "not exposed by WorkflowEngine 1.0.0",
    agents: connected.agents.length,
  };
  print(
    ctx,
    `engine verify: owner token accepted\ncontract: ${connected.contract.version}\nidentity: not exposed by WorkflowEngine 1.0.0`,
    result,
  );
  return 0;
}

async function commandCapabilities(ctx) {
  const available = ENGINE_COMMANDS.filter((command) => command.status === "available");
  const blockedCommands = ENGINE_COMMANDS.filter((command) => command.status === "blocked");
  let deployment = { configured: Boolean(ctx.baseUrl), authenticated: false, contractVersion: null };
  let failure = null;

  if (ctx.baseUrl) {
    try {
      const health = await engineHealth(ctx);
      deployment.contractVersion = health.contract.version;
      if (ctx.token) {
        const connected = await connectEngine(ctx);
        deployment.authenticated = true;
        deployment.agents = connected.agents.length;
      }
    } catch (error) {
      if (error instanceof CoderaxError) {
        failure = { code: error.code, message: error.message };
      } else {
        throw error;
      }
    }
  }

  const result = {
    contractVersion: ENGINE_CONTRACT_VERSION,
    deployment,
    ...(failure ? { failure } : {}),
    commands: ENGINE_COMMANDS.map((command) => ({
      name: command.name,
      status:
        command.status === "available" &&
        (!deployment.configured || !deployment.authenticated)
          ? "unconfigured"
          : command.status,
      usage: command.usage,
      operation: command.operation,
      summary: command.summary ?? command.reason,
    })),
  };

  if (ctx.json) {
    ctx.out(formatJson(result));
  } else {
    const lines = [
      `authoritative contract: ${ENGINE_CONTRACT_VERSION}`,
      `deployment: ${deployment.configured ? deployment.contractVersion ?? "unreachable" : "not configured"}`,
      `owner token: ${deployment.authenticated ? "verified" : "not verified"}`,
      ...(failure ? [`failure: ${failure.code}: ${failure.message}`] : []),
      "",
      "Available:",
      ...available.map((command) => `  engine ${command.name} - ${command.summary}`),
      "",
      "Blocked (no request sent):",
      ...blockedCommands.map((command) => `  engine ${command.name} - ${command.reason}`),
    ];
    ctx.out(lines.join("\n"));
  }
  if (failure?.code === "API_VERSION_UNSUPPORTED") return 6;
  return 0;
}

/**
 * Give the adopted handlers this CLI's context shape. Human output is
 * sanitized here; machine output is left authoritative.
 */
function surfaceContext(ctx, args, flags = ctx.flags) {
  const settings = {
    ...ctx.settings,
    eventTimeoutMs: ctx.settings.eventTimeoutMs ?? 60_000,
    mode: ctx.settings.mode ?? "",
  };
  return {
    ...ctx,
    args,
    flags,
    settings,
    out: ctx.json ? ctx.out : (text) => ctx.out(safeText(text)),
    raw: ctx.json ? ctx.raw : (text) => ctx.raw(safeText(text)),
    err: (text) => ctx.err(safeText(text)),
  };
}

function requireTaskId(args, command) {
  if (!args[0]) throw new EngineUsageError(`${command} requires a task id`);
  return assertIdentifier(args[0], "taskId");
}

function requireConversationId(value) {
  if (value === undefined) return;
  assertIdentifier(value, "conversationId");
}

function adaptWork(ctx, args) {
  const rest = args[0] === "submit" ? args.slice(1) : [...args];
  const flags = new Map(ctx.flags);
  if (flags.has("follow") && flags.has("detach")) {
    throw new EngineUsageError("--follow and --detach cannot be combined");
  }

  if (flags.has("data")) {
    if (rest.length > 0) {
      throw new EngineUsageError("--data cannot be combined with a positional objective");
    }
    const conflicting = ["agent", "model", "mode", "conversation", "no-approval"].filter((name) =>
      flags.has(name),
    );
    if (conflicting.length > 0) {
      throw new EngineUsageError(
        `--data cannot be combined with ${conflicting.map((name) => `--${name}`).join(", ")}`,
      );
    }
    const body = validateWorkBody(parseJsonBody({ ...ctx, flags }));
    if (body.budget !== undefined) {
      throw new EngineUsageError("--data budget is not supported by the adopted engine surface");
    }
    rest.push(body.objective);
    if (body.agent !== undefined) flags.set("agent", body.agent);
    if (body.mode !== undefined) flags.set("mode", body.mode);
    if (body.conversationId !== undefined) flags.set("conversation", body.conversationId);
    if (body.model !== undefined) {
      flags.set("model", `${body.model.providerId}/${body.model.modelId}`);
    }
    if (body.requireApproval === false) flags.set("no-approval", true);
    flags.delete("data");
  }

  if (rest.join(" ").trim() === "") {
    throw new EngineUsageError("engine work submit requires an objective");
  }
  if (flags.has("after") && !/^\d+$/.test(String(flags.get("after")))) {
    throw new EngineUsageError("--after must be a non-negative integer");
  }
  requireConversationId(flags.get("conversation"));

  // This CLI's documented default is submit-only; --follow opts into the
  // owner surface's streaming mode. --detach remains an explicit alias.
  if (!flags.has("follow")) flags.set("detach", true);
  return surfaceContext(ctx, rest, flags);
}

/**
 * Validate and adapt arguments without touching the network. The caller runs
 * `connectEngine` only after this returns, so malformed input and path
 * traversal fail before the owner token is sent.
 */
function prepareSurface(ctx, name, args) {
  if (name === "work") {
    return { name: "work", ctx: adaptWork(ctx, args) };
  }

  if (name === "tasks") {
    if (["events", "cancel", "resume", "retry"].includes(args[0])) {
      return prepareSurface(ctx, args[0], args.slice(1));
    }
    if (args.length > 0) {
      requireTaskId(args, "tasks");
      return { name: "task", ctx: surfaceContext(ctx, args) };
    }
    return { name: "tasks", ctx: surfaceContext(ctx, args) };
  }

  if (name === "permissions" && args[0] === "decide") {
    const [, taskId, requestId, decision] = args;
    if (!taskId || !requestId) {
      throw new EngineUsageError("permissions decide requires <taskId> <requestId> approve|deny");
    }
    if (decision !== "approve" && decision !== "deny") {
      throw new EngineUsageError("permission decision must be approve or deny");
    }
    assertIdentifier(taskId, "taskId");
    assertIdentifier(requestId, "requestId");
    return {
      name: decision === "approve" ? "approve" : "deny",
      ctx: surfaceContext(ctx, [taskId, requestId]),
    };
  }

  if (TASK_COMMANDS.has(name)) {
    const taskId = requireTaskId(args, name);
    if (name === "approve" || name === "deny") {
      if (!args[1]) throw new EngineUsageError(`${name} requires a request id`);
      assertIdentifier(args[1], "requestId");
    }
    if (name === "events" && ctx.flags.has("after")) {
      const after = ctx.flags.get("after");
      if (!/^\d+$/.test(String(after))) {
        throw new EngineUsageError("--after must be a non-negative integer");
      }
    }
    if ((name === "resume" || name === "retry") && ctx.flags.has("generation")) {
      const generation = ctx.flags.get("generation");
      if (!/^\d+$/.test(String(generation))) {
        throw new EngineUsageError("--generation must be a non-negative integer");
      }
    }
    return { name, ctx: surfaceContext(ctx, [taskId, ...args.slice(1)]) };
  }

  if (name === "conversation") {
    if (!args[0]) throw new EngineUsageError("conversation requires a conversation id");
    assertIdentifier(args[0], "conversationId");
    return { name, ctx: surfaceContext(ctx, args) };
  }

  if (name === "conversations" && args.length > 0) {
    throw new EngineUsageError("conversations takes no positional arguments; use `engine conversation <id>`");
  }

  if (name === "chat") {
    requireConversationId(ctx.flags.get("conversation"));
    return { name, ctx: surfaceContext(ctx, args) };
  }

  if (name === "memory") {
    const mode = ctx.flags.get("mode") ?? "private";
    if (!["private", "cloud"].includes(mode)) {
      throw new EngineUsageError("--mode must be private or cloud");
    }
  }

  if (typeof surface[name] !== "function") {
    throw new EngineUsageError(`engine command is not wired: ${name}`);
  }
  return { name, ctx: surfaceContext(ctx, args) };
}

/**
 * Dispatch one `engine` invocation. `ctx.args` excludes the `engine` token.
 */
export async function runEngineCommand(ctx) {
  const [subcommand, ...args] = ctx.args;
  if (!subcommand || subcommand === "help") {
    return printHelp(ctx, args[0]);
  }
  const command = findEngineCommand(subcommand);
  if (command === null) {
    throw new EngineUsageError(
      `unknown engine command: ${subcommand}. Run \`coderax engine help\`.`,
    );
  }
  if (command.status === "blocked") {
    return blocked(ctx, command.name, command.reason);
  }

  switch (command.name) {
    case "login":
      return commandLogin(ctx);
    case "logout":
      return commandLogout(ctx);
    case "health":
      return commandHealth(ctx);
    case "ready":
      return commandReady(ctx);
    case "compat":
      return commandCompat(ctx);
    case "verify":
      return commandVerify(ctx);
    case "capabilities":
      return commandCapabilities(ctx);
    case "status":
      return surface.status(surfaceContext(ctx, args));
    case "doctor":
      return surface.doctor(surfaceContext(ctx, args));
    default: {
      // Every remaining handler is backed by an authenticated operation. Local
      // input validation happens first; then the contract and owner proof run
      // before the handler can send one.
      const prepared = prepareSurface(ctx, command.name, args);
      await connectEngine(ctx);
      return surface[prepared.name](prepared.ctx);
    }
  }
}
