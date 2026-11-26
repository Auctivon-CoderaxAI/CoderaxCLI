import { CoderaxError, EXIT } from "../errors.js";
import { saveConfig } from "../config.js";
import { validateSecret } from "../credentials.js";
import { createEngineClient } from "../engine/client.js";
import { CONTRACT_VERSION } from "../engine/contract.js";
import { VERSION } from "../version.js";
import { PromptSession } from "../ui/prompt.js";

function tempProvider(token) {
  return {
    async get() {
      return token;
    },
    async refresh() {
      throw new CoderaxError("AUTH_REFRESH_UNAVAILABLE", "the token was rejected");
    },
    setToken() {},
    describe() {
      return { configured: true, source: "login" };
    },
  };
}

async function verifyToken(runtime, token) {
  if (!runtime.engineUrl) {
    throw new CoderaxError(
      "ENGINE_URL_REQUIRED",
      "no WorkflowEngine URL is configured; run `coderax config set --engine-url <url>` first",
    );
  }
  const client = createEngineClient({
    baseUrl: runtime.engineUrl,
    tokenProvider: tempProvider(token),
    fetchImpl: runtime.fetchImpl,
    timeoutMs: runtime.config.timeoutMs,
  });
  const health = await client.negotiate();
  const agents = await client.agents({ refresh: true });
  return { health, agents };
}

async function readToken(runtime) {
  if (runtime.flags.has("token")) {
    runtime.err("coderax: warning: --token is visible in shell history and process listings; prefer `coderax login` with a prompt or --token-stdin");
    return runtime.flags.get("token");
  }
  if (runtime.flags.has("token-stdin")) {
    if (runtime.isTTY) throw new CoderaxError("USAGE", "--token-stdin expects a piped token, not a terminal");
    const value = (await runtime.readStdin()).trim();
    if (!value) throw new CoderaxError("USAGE", "stdin contained no token");
    return value;
  }
  const envToken = runtime.env.CODERAX_ENGINE_TOKEN?.trim() || runtime.env.CODERAX_TOKEN?.trim();
  if (envToken) return envToken;
  if (!runtime.isTTY) {
    const value = (await runtime.readStdin()).trim();
    if (value) return value;
  }
  if (!runtime.isTTY) {
    throw new CoderaxError("USAGE", "no token supplied; pipe one with --token-stdin or set CODERAX_TOKEN");
  }
  const prompt = new PromptSession({
    input: runtime.stdin,
    output: runtime.stdoutStream,
    error: runtime.stderrStream,
    style: runtime.style,
  });
  try {
    return await prompt.secret("Owner token (input hidden): ");
  } finally {
    prompt.close();
  }
}

export async function login(runtime) {
  const raw = await readToken(runtime);
  let token;
  try {
    token = validateSecret(raw);
  } catch (error) {
    throw new CoderaxError("USAGE", error.message);
  }

  const { health, agents } = await verifyToken(runtime, token);
  const written = await runtime.store.write(token);
  await saveConfig(
    { token: null, account: new URL(runtime.engineUrl).host, engineUrl: runtime.engineUrl },
    { filePath: runtime.configPath },
  );
  runtime.setToken(token);

  const data = {
    authenticated: true,
    engineUrl: runtime.engineUrl,
    contractVersion: health.contractVersion,
    agents: agents.agents.map((agent) => agent.id),
    credentialStore: written.kind ?? "unknown",
    warning: written.warning ?? null,
  };
  runtime.emit("login", data, () => {
    runtime.write(`${runtime.style.green("\u2713")} signed in to ${new URL(runtime.engineUrl).host}`);
    runtime.write(`contract ${health.contractVersion}  agents ${agents.agents.map((agent) => agent.id).join(", ")}`);
    runtime.write(`token stored in ${written.kind === "keychain" ? runtime.store.describe().backend : written.kind}`);
    if (written.warning) runtime.write(runtime.style.yellow(`warning: ${written.warning}`));
  });
  return EXIT.OK;
}

export async function logout(runtime) {
  const result = await runtime.store.delete();
  await saveConfig({ token: null, account: null }, { filePath: runtime.configPath });
  runtime.setToken(null);
  const environmentActive = Boolean(runtime.env.CODERAX_ENGINE_TOKEN?.trim() || runtime.env.CODERAX_TOKEN?.trim());
  const data = {
    removed: result.backendRemoved || result.fileRemoved,
    environmentTokenActive: environmentActive,
  };
  runtime.emit("logout", data, () => {
    runtime.write(data.removed ? "Signed out. The owner token was removed from the credential store." : "No stored owner token.");
    if (environmentActive) {
      runtime.write(runtime.style.yellow("CODERAX_TOKEN or CODERAX_ENGINE_TOKEN is still set; unset it to sign out of this environment."));
    }
  });
  return EXIT.OK;
}

export async function status(runtime) {
  const token = runtime.tokenInfo();
  const store = runtime.store.describe();
  const state = await runtime.state.load();
  const tasks = Object.values(state.tasks);
  const activeTasks = tasks.filter((task) => !["completed", "failed", "cancelled", "interrupted"].includes(task.state));
  let health = null;
  let contract = null;
  let healthError = null;
  if (runtime.engineUrl) {
    try {
      const client = await runtime.getEngine({ negotiate: false });
      health = await client.health();
      contract = {
        client: CONTRACT_VERSION,
        server: health.contractVersion,
        compatible: health.contractVersion === CONTRACT_VERSION,
      };
    } catch (error) {
      healthError = { code: error.code ?? "ERROR", message: runtime.redact(error.message) };
    }
  }
  let unread = null;
  let localUnseen = 0;
  if (token.configured) {
    try {
      const client = await runtime.getEngine({ negotiate: false });
      const notifications = await client.notifications();
      unread = notifications.unread;
      localUnseen = notifications.notifications.filter((entry) => !state.notifications.seen[`${entry.taskId}:${entry.state}:${entry.createdAt}`]).length;
    } catch {
      // Status is informative; an unreachable notification endpoint is reported elsewhere.
    }
  }

  const data = {
    version: VERSION,
    engineUrl: runtime.engineUrl,
    engineUrlExplicit: Boolean(runtime.config.engineUrl),
    baseUrl: runtime.baseUrl,
    authenticated: token.configured,
    token: token.configured ? { masked: token.masked, source: token.source } : null,
    credentialStore: store,
    contract,
    health: health ? { status: health.status, uptimeMs: health.uptimeMs } : null,
    healthError,
    configPath: runtime.configPath,
    statePath: runtime.state.filePath,
    active: state.active,
    tasks: { total: tasks.length, active: activeTasks.length },
    notifications: { unread, localUnseen },
  };
  runtime.emit("status", data, () => {
    const line = (label, value) => runtime.write(`${runtime.style.dim(label.padEnd(14))} ${value}`);
    line("Coderax CLI", VERSION);
    line("engine", runtime.engineUrl ?? runtime.style.yellow("(not configured)"));
    line("deployment", runtime.baseUrl ?? "(not configured)");
    if (health) {
      line("contract", `${health.contractVersion}${contract.compatible ? "" : runtime.style.red(" (incompatible)")}`);
      line("health", health.status);
    } else if (healthError) {
      line("health", runtime.style.red(`${healthError.code}: ${healthError.message}`));
    }
    line(
      "auth",
      token.configured
        ? `configured (${token.masked} via ${token.source})`
        : runtime.style.yellow("not configured; run `coderax login`"),
    );
    line("credential store", store.backend);
    line("mode", state.active.mode);
    line("session", state.active.mode === "work" ? state.active.workConversationId ?? "(new)" : state.active.chatConversationId ?? "(new)");
    line("tasks", `${tasks.length} known, ${activeTasks.length} active`);
    if (unread !== null) line("notifications", `${unread} unread, ${localUnseen} not shown here`);
    line("config", runtime.configPath);
  });
  return EXIT.OK;
}

export async function refreshAuth(runtime) {
  const before = runtime.tokenInfo();
  if (!before.configured) {
    throw new CoderaxError("UNAUTHENTICATED", "no owner token is configured; run `coderax login`");
  }
  const token = await runtime.tokenProvider.refresh();
  runtime.setToken(token);
  const client = await runtime.getEngine({ negotiate: true, force: true });
  const agents = await client.agents({ refresh: true });
  const after = runtime.tokenInfo();
  runtime.emit("auth.refresh", {
    refreshed: true,
    previousFingerprint: before.fingerprint,
    currentFingerprint: after.fingerprint,
    agents: agents.agents.length,
  }, () => {
    runtime.write(`${runtime.style.green("\u2713")} owner token refreshed (${after.masked})`);
    runtime.write(runtime.style.dim("the token value was not printed"));
  });
  return EXIT.OK;
}
