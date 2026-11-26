/**
 * `coderax engine ...` handlers.
 *
 * The engine namespace is deliberately separate from the legacy Coderax
 * deployment commands. Every available handler validates the served contract
 * and owner token first; every blocked handler returns before any request.
 */
import { CoderaxError, formatJson } from "./client.js";
import { loadConfig, maskToken, saveConfig } from "./config.js";
import { credentialBackend, readTokenFile } from "./credentials.js";
import {
  ENGINE_COMMANDS,
  ENGINE_CONTRACT_VERSION,
  ENGINE_OPERATIONS,
  findEngineCommand,
} from "./command-registry.js";
import {
  assertIdentifier,
  connectEngine,
  engineHealth,
  engineReady,
  engineRequest,
  routePath,
  streamTaskEvents,
} from "./engine-client.js";

const AGENTS = new Set(["coderax", "opencode", "freebuff"]);
const MODES = new Set(["private", "cloud"]);
const WORK_KEYS = new Set([
  "objective",
  "conversationId",
  "agent",
  "model",
  "mode",
  "budget",
  "requireApproval",
]);

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

export class EngineUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineUsageError";
    this.code = "USAGE";
  }
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

function parseDataMode(ctx) {
  if (!ctx.flags.has("mode")) return null;
  const mode = requireValue(ctx, "mode");
  if (!MODES.has(mode)) throw new EngineUsageError("--mode must be private or cloud");
  return mode;
}

function parseAgent(ctx) {
  const raw = ctx.flags.has("agent") ? requireValue(ctx, "agent") : ctx.agent;
  if (raw === undefined || raw === null || raw === "") return null;
  if (!AGENTS.has(raw)) {
    throw new EngineUsageError("--agent must be one of coderax, opencode or freebuff");
  }
  return raw;
}

function parseModelFlag(ctx) {
  if (!ctx.flags.has("model")) return null;
  const raw = requireValue(ctx, "model");
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new EngineUsageError("--model must be <provider>/<model>");
  }
  const providerId = raw.slice(0, slash);
  const modelId = raw.slice(slash + 1);
  if (providerId.length > 64 || modelId.length > 160) {
    throw new EngineUsageError("--model provider or model id is too long");
  }
  return { providerId, modelId };
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

function parseNonNegativeInt(raw, label) {
  if (!/^\d+$/.test(String(raw))) {
    throw new EngineUsageError(`${label} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new EngineUsageError(`${label} is too large`);
  }
  return value;
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
  if (body.mode !== undefined && !MODES.has(body.mode)) {
    throw new EngineUsageError("Work mode must be private or cloud");
  }
  if (body.agent !== undefined && !AGENTS.has(body.agent)) {
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

async function withFollower(ctx, accepted) {
  if (!ctx.flags.has("follow")) return accepted;
  const taskId = assertIdentifier(accepted.taskId, "taskId");
  let task = accepted;
  for (;;) {
    if (ctx.signal?.aborted) {
      throw new CoderaxError("CANCELLED", "stopped following the task");
    }
    const response = await engineRequest(ctx, {
      operationId: "getTask",
      params: { taskId },
    });
    task = response.body;
    if (ctx.json) {
      // stdout stays one JSON document; progress goes to stderr.
      ctx.err(`task ${taskId}: ${task.state}`);
    } else {
      ctx.out(`task ${taskId}: ${task.state}`);
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
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
  const lines = [
    `coderax engine - authoritative WorkflowEngine ${ENGINE_CONTRACT_VERSION} commands`,
    "",
    "Available:",
    ...ENGINE_COMMANDS.filter((command) => command.status === "available").map(
      (command) => `  ${command.usage}\n    ${command.summary}`,
    ),
    "",
    "Blocked by the 1.0.0 contract (no request is sent):",
    ...ENGINE_COMMANDS.filter((command) => command.status === "blocked").map(
      (command) => `  engine ${command.name} - ${command.reason}`,
    ),
    "",
    "Run `coderax engine capabilities --json` for the machine-readable matrix.",
  ];
  ctx.out(ctx.json ? formatJson({ contractVersion: ENGINE_CONTRACT_VERSION, commands: ENGINE_COMMANDS }) : lines.join("\n"));
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

  // Owner proof: an owner-only operation must succeed before the token is
  // written anywhere. The engine has one principal, so this proves ownership.
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

async function commandAgents(ctx) {
  const connected = await connectEngine(ctx);
  const lines = connected.agents.map(
    (agent) =>
      `${agent.id.padEnd(9)} ${agent.availability.available ? "ready" : "unavailable"} (${agent.availability.reason}) ${safeText(agent.label)}`,
  );
  print(ctx, lines.join("\n"), { contractVersion: connected.contract.version, agents: connected.agents });
  return 0;
}

async function commandModels(ctx) {
  const connected = await connectEngine(ctx);
  const response = await engineRequest(ctx, { operationId: "listModels" });
  const models = response.body?.models ?? [];
  const lines = models.map(
    (model) =>
      `${model.ref.providerId}/${model.ref.modelId} ${model.costClass} ${model.availability.available ? "ready" : "unavailable"} (${model.availability.reason})`,
  );
  print(ctx, lines.join("\n"), {
    contractVersion: connected.contract.version,
    ...response.body,
  });
  return 0;
}

async function commandChat(ctx) {
  const message = ctx.args.slice(1).join(" ").trim();
  if (!message) throw new EngineUsageError("engine chat requires a message");
  if (message.length > 200_000) throw new EngineUsageError("the chat message is too long");
  const body = { message };
  const agent = parseAgent(ctx);
  if (agent) body.agent = agent;
  const mode = parseDataMode(ctx);
  if (mode) body.mode = mode;
  const model = parseModelFlag(ctx);
  if (model) body.model = model;
  if (ctx.flags.has("conversation") && ctx.flags.has("new")) {
    throw new EngineUsageError("--conversation and --new cannot be combined");
  }
  if (ctx.flags.has("conversation") && !ctx.flags.has("new")) {
    body.conversationId = assertIdentifier(requireValue(ctx, "conversation"), "conversationId");
  }
  const connected = await connectEngine(ctx);
  const response = await engineRequest(ctx, {
    operationId: "submitChat",
    method: "POST",
    body,
  });
  const reply = response.body;
  print(
    ctx,
    `${safeText(reply.text)}\n\nconversation: ${reply.conversationId}\nmessage: ${reply.messageId}`,
    { contractVersion: connected.contract.version, ...reply },
  );
  return 0;
}

async function commandWork(ctx) {
  if (ctx.args[1] !== "submit") {
    throw new EngineUsageError("usage: coderax engine work submit <objective> [--follow]");
  }
  let body;
  if (ctx.flags.has("data")) {
    if (ctx.args.length > 2) {
      throw new EngineUsageError("--data cannot be combined with a positional objective");
    }
    const conflicting = ["agent", "model", "mode", "conversation", "no-approval"].filter((name) =>
      ctx.flags.has(name),
    );
    if (conflicting.length > 0) {
      throw new EngineUsageError(
        `--data cannot be combined with ${conflicting.map((name) => `--${name}`).join(", ")}`,
      );
    }
    body = validateWorkBody(parseJsonBody(ctx));
  } else {
    const objective = ctx.args.slice(2).join(" ").trim();
    if (!objective) throw new EngineUsageError("engine work submit requires an objective");
    body = {
      objective,
      requireApproval: !ctx.flags.has("no-approval"),
    };
    const agent = parseAgent(ctx);
    if (agent) body.agent = agent;
    const mode = parseDataMode(ctx);
    if (mode) body.mode = mode;
    const model = parseModelFlag(ctx);
    if (model) body.model = model;
    if (ctx.flags.has("conversation")) {
      body.conversationId = assertIdentifier(requireValue(ctx, "conversation"), "conversationId");
    }
    validateWorkBody(body);
  }
  const connected = await connectEngine(ctx);
  const response = await engineRequest(ctx, {
    operationId: "submitWork",
    method: "POST",
    body,
  });
  const accepted = response.body;
  if (!accepted || typeof accepted.taskId !== "string") {
    throw new CoderaxError("CONTRACT_VIOLATION", "POST /v1/work did not return a task");
  }
  const final = await withFollower(ctx, accepted);
  if (ctx.flags.has("follow")) {
    print(
      ctx,
      `engine work: ${final.state}\n${safeText(final.result?.summary ?? final.failure?.detail ?? "")}`,
      { contractVersion: connected.contract.version, task: final },
    );
  } else {
    print(
      ctx,
      `engine work: ${accepted.state}\ntask: ${accepted.taskId}\nevents: ${accepted.eventsPath}`,
      { contractVersion: connected.contract.version, task: accepted },
    );
  }
  return 0;
}

async function commandTask(ctx) {
  const [action, taskArg] = [ctx.args[1], ctx.args[2]];
  if (!action) {
    return blocked(
      ctx,
      "tasks (list)",
      "WorkflowEngine 1.0.0 has no task-list operation; read a task by id instead.",
    );
  }

  if (action === "events") {
    const taskId = assertIdentifier(taskArg, "taskId");
    const after = ctx.flags.has("after")
      ? parseNonNegativeInt(requireValue(ctx, "after"), "--after")
      : 0;
    await connectEngine(ctx);
    let sawTerminal = false;
    for await (const event of streamTaskEvents({
      baseUrl: ctx.baseUrl,
      token: ctx.token,
      taskId,
      after,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    })) {
      sawTerminal ||= ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(
        event?.type,
      );
      if (ctx.json) {
        // NDJSON: one compact object per line, streamed as it arrives.
        ctx.raw(`${JSON.stringify(event)}\n`);
      } else {
        const detail =
          event?.type === "text.delta"
            ? event.payload?.text ?? ""
            : event?.payload?.summary ?? event?.payload?.title ?? "";
        ctx.out(
          `${String(event?.seq ?? "").padStart(4)} ${event?.type ?? "event"} ${safeText(detail)}`.trim(),
        );
      }
    }
    return sawTerminal ? 0 : 7;
  }

  if (["cancel", "resume", "retry"].includes(action)) {
    const taskId = assertIdentifier(taskArg, "taskId");
    await connectEngine(ctx);
    let generation;
    if (ctx.flags.has("generation")) {
      generation = parseNonNegativeInt(requireValue(ctx, "generation"), "--generation");
    } else if (action !== "cancel") {
      const current = await engineRequest(ctx, {
        operationId: "getTask",
        params: { taskId },
      });
      generation = current.body?.generation;
      if (!Number.isInteger(generation)) {
        throw new CoderaxError("CONTRACT_VIOLATION", "the task did not report a generation");
      }
    }
    const body = {};
    if (action === "cancel") {
      if (ctx.flags.has("reason")) body.reason = requireValue(ctx, "reason");
    } else {
      body.generation = generation;
      if (action === "retry" && ctx.flags.has("model")) body.model = parseModelFlag(ctx);
    }
    const response = await engineRequest(ctx, {
      operationId: `${action}Task`,
      method: "POST",
      params: { taskId },
      body,
    });
    print(
      ctx,
      `task ${response.body.taskId}: ${response.body.outcome} (${response.body.state})`,
      response.body,
    );
    return 0;
  }

  const taskId = assertIdentifier(action, "taskId");
  const connected = await connectEngine(ctx);
  const response = await engineRequest(ctx, {
    operationId: "getTask",
    params: { taskId },
  });
  print(
    ctx,
    `task ${response.body.taskId}\nstate: ${response.body.state}\nconversation: ${response.body.conversationId}\nagent: ${response.body.agent}\nsteps:\n${(response.body.steps ?? []).map((step) => `  ${step.id} ${step.state} ${safeText(step.title)}`).join("\n")}\n${response.body.result?.summary ? `\n${safeText(response.body.result.summary)}` : ""}${response.body.failure ? `\n${response.body.failure.code}: ${safeText(response.body.failure.detail ?? "")}` : ""}`,
    { contractVersion: connected.contract.version, task: response.body },
  );
  return 0;
}

async function commandConversations(ctx) {
  const first = ctx.args[1];
  // Validate a direct conversation id before the owner token is used.
  const id =
    first === "show"
      ? assertIdentifier(ctx.args[2], "conversationId")
      : first === undefined
        ? null
        : assertIdentifier(first, "conversationId");
  const connected = await connectEngine(ctx);
  if (id !== null) {
    const response = await engineRequest(ctx, {
      operationId: "getConversation",
      params: { conversationId: id },
    });
    const conversation = response.body;
    print(
      ctx,
      `conversation ${conversation.conversationId} (${conversation.agent}, ${conversation.isWork ? "work" : "chat"})\n${conversation.messages.map((message) => `  ${message.role}: ${safeText(message.text)}`).join("\n")}`,
      { contractVersion: connected.contract.version, conversation },
    );
    return 0;
  }
  const response = await engineRequest(ctx, { operationId: "listConversations" });
  const conversations = response.body?.conversations ?? [];
  print(
    ctx,
    conversations.length === 0
      ? "no conversations"
      : conversations
          .map(
            (conversation) =>
              `${conversation.conversationId} ${conversation.isWork ? "work" : "chat"} ${conversation.agent} ${conversation.updatedAt} ${conversation.title ?? ""}`,
          )
          .join("\n"),
    { contractVersion: connected.contract.version, ...response.body },
  );
  return 0;
}

async function commandMemory(ctx) {
  const mode = ctx.flags.has("mode") ? requireValue(ctx, "mode") : "private";
  if (!MODES.has(mode)) throw new EngineUsageError("--mode must be private or cloud");
  const connected = await connectEngine(ctx);
  const response = await engineRequest(ctx, {
    operationId: "listMemory",
    query: { mode },
  });
  const entries = response.body?.entries ?? [];
  print(
    ctx,
    entries.length === 0
      ? `no ${mode} memory entries`
      : entries.map((entry) => `${safeText(entry.key)}: ${safeText(entry.value)}`).join("\n"),
    { contractVersion: connected.contract.version, ...response.body },
  );
  return 0;
}

async function commandPermissions(ctx) {
  const action = ctx.args[1];
  if (action === "decide") {
    const taskId = assertIdentifier(ctx.args[2], "taskId");
    const requestId = assertIdentifier(ctx.args[3], "requestId");
    const decision = ctx.args[4];
    if (decision !== "approve" && decision !== "deny") {
      throw new EngineUsageError("permission decision must be approve or deny");
    }
    await connectEngine(ctx);
    const body = {
      requestId,
      decision: decision === "approve" ? "approved" : "denied",
    };
    if (ctx.flags.has("reason")) body.reason = requireValue(ctx, "reason");
    const response = await engineRequest(ctx, {
      operationId: "decidePermission",
      method: "POST",
      params: { taskId },
      body,
    });
    print(
      ctx,
      (response.body?.requests ?? [])
        .map((request) => `${request.requestId} ${request.scope} ${request.decision}`)
        .join("\n") || "decision recorded",
      response.body,
    );
    return 0;
  }

  const taskId = assertIdentifier(action, "taskId");
  await connectEngine(ctx);
  const response = await engineRequest(ctx, {
    operationId: "listPermissions",
    params: { taskId },
  });
  const requests = response.body?.requests ?? [];
  print(
    ctx,
    requests.length === 0
      ? "no permission requests"
      : requests
          .map(
            (request) =>
              `${request.requestId} ${request.decision} ${request.scope} ${safeText(request.resource)} - ${safeText(request.description)}`,
          )
          .join("\n"),
    response.body,
  );
  return 0;
}

async function commandNotifications(ctx) {
  const connected = await connectEngine(ctx);
  const response = await engineRequest(ctx, { operationId: "listNotifications" });
  const notifications = response.body?.notifications ?? [];
  print(
    ctx,
    notifications.length === 0
      ? "no notifications"
      : notifications
          .map(
            (notification) =>
              `${notification.read ? "read" : "unread"} ${notification.state} ${notification.taskId} ${safeText(notification.summary ?? "")}`,
          )
          .join("\n"),
    { contractVersion: connected.contract.version, ...response.body },
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
 * Dispatch one `engine` invocation. `ctx.args` excludes the `engine` token.
 */
export async function runEngineCommand(ctx) {
  const [subcommand, ...rest] = ctx.args;
  if (!subcommand || subcommand === "help") {
    return printHelp(ctx, rest[0]);
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
    case "doctor":
      return commandCompat(ctx);
    case "verify":
      return commandVerify(ctx);
    case "agents":
      return commandAgents(ctx);
    case "models":
      return commandModels(ctx);
    case "chat":
      return commandChat(ctx);
    case "work":
      return commandWork(ctx);
    case "tasks":
      return commandTask(ctx);
    case "conversations":
      return commandConversations(ctx);
    case "memory":
      return commandMemory(ctx);
    case "permissions":
      return commandPermissions(ctx);
    case "notifications":
      return commandNotifications(ctx);
    case "capabilities":
      return commandCapabilities(ctx);
    default:
      throw new EngineUsageError(`engine command is not wired: ${command.name}`);
  }
}

/** Exported for the capability matrix test and docs. */
export function operationSummary() {
  return Object.entries(ENGINE_OPERATIONS).map(([id, operation]) => ({ id, ...operation }));
}
